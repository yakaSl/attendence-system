package hikvision

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestParseDigestChallenge(t *testing.T) {
	challenge, err := parseDigestChallenge(`Basic realm="fallback", Digest realm="test,realm", nonce="abc", opaque="xyz", algorithm=MD5, qop="auth,auth-int"`)
	if err != nil {
		t.Fatal(err)
	}
	if challenge.Realm != "test,realm" || challenge.Nonce != "abc" || challenge.QOP != "auth,auth-int" || !challenge.OpaquePresent || !challenge.AlgorithmPresent {
		t.Fatalf("unexpected challenge: %+v", challenge)
	}
}

func TestDigestAuthorizationPreservesHikvisionChallengeShape(t *testing.T) {
	challenge, err := parseDigestChallenge(`Digest qop="auth", realm="DS-17D91262", nonce="device-nonce", stale="false", opaque="", domain="::"`)
	if err != nil {
		t.Fatal(err)
	}
	header, err := buildDigestAuthorizationWithNonce(
		challenge,
		"admin",
		"secret",
		"POST",
		"/ISAPI/AccessControl/AcsEvent?format=json",
		"test-cnonce",
		1,
	)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(header, "algorithm=") {
		t.Fatalf("authorization invented an algorithm parameter: %s", header)
	}
	if !strings.Contains(header, `opaque=""`) {
		t.Fatalf("authorization did not return the empty opaque value: %s", header)
	}
}

func TestDigestAuthorizationRFCExample(t *testing.T) {
	challenge := digestChallenge{
		Realm:     "testrealm@host.com",
		Nonce:     "dcd98b7102dd2f0e8b11d0f600bfb0c093",
		Opaque:    "5ccc069c403ebaf9f0171e9517f40e41",
		Algorithm: "MD5",
		QOP:       "auth",
	}
	header, err := buildDigestAuthorizationWithNonce(
		challenge,
		"Mufasa",
		"Circle Of Life",
		"GET",
		"/dir/index.html",
		"0a4f113b",
		1,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(header, `response="6629fae49393a05397450978507c4ef1"`) {
		t.Fatalf("unexpected authorization: %s", header)
	}
}

func TestDigestClientGetsFreshChallengeForEveryRequest(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestNumber := requests.Add(1)
		nonce := "nonce-1"
		if requestNumber > 2 {
			nonce = "nonce-2"
		}
		authorization := request.Header.Get("Authorization")
		if requestNumber%2 == 1 {
			if authorization != "" {
				t.Fatalf("challenge request %d included authorization: %s", requestNumber, authorization)
			}
			response.Header().Set("WWW-Authenticate", `Digest realm="hikvision", nonce="`+nonce+`", algorithm=MD5, qop="auth"`)
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		if !strings.Contains(authorization, `nonce="`+nonce+`"`) {
			t.Fatalf("authenticated request %d did not use %s: %s", requestNumber, nonce, authorization)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"DeviceInfo":{"model":"DS-K1A8503EF","serialNumber":"ABC"}}`))
	}))
	defer server.Close()
	client := New(Options{
		BaseURL:    server.URL,
		DeviceID:   "device-1",
		Username:   "admin",
		Password:   "secret",
		HTTPClient: server.Client(),
	})
	if _, err := client.DeviceInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := client.DeviceInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 4 {
		t.Fatalf("requests = %d; want two fresh challenge exchanges", requests.Load())
	}
}
