package realtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"infactsolutions/hikbridge/internal/syncer"
)

func TestClientCreatesSignedSessionAndReceivesSignal(t *testing.T) {
	const deviceID = "office-main-01"
	const bridgeKey = "0123456789abcdef0123456789abcdef"
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/session":
			body, err := io.ReadAll(request.Body)
			if err != nil {
				t.Error(err)
				response.WriteHeader(http.StatusBadRequest)
				return
			}
			expectedSignature := syncer.ComputeSignature(
				[]byte(bridgeKey),
				request.Header.Get("X-HikBridge-Device"),
				request.Header.Get("X-HikBridge-Timestamp"),
				request.Header.Get("X-HikBridge-Nonce"),
				body,
			)
			if request.Header.Get("X-HikBridge-Signature") != expectedSignature {
				t.Error("session request signature did not cover the exact request")
				response.WriteHeader(http.StatusUnauthorized)
				return
			}
			var payload struct {
				ProtocolVersion string `json:"protocolVersion"`
				RequestID       string `json:"requestId"`
				DeviceID        string `json:"deviceId"`
			}
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Error(err)
				response.WriteHeader(http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(response).Encode(sessionResponse{
				ProtocolVersion: protocolVersion,
				RequestID:       payload.RequestID,
				DeviceID:        payload.DeviceID,
				OrganizationID:  "org-1",
				DatabaseURL:     server.URL,
				FirebaseAPIKey:  "firebase-api-key",
				CustomToken:     "custom-token",
				ControlPath:     "bridgeRealtime/v1/control/org-1/office-main-01",
			})
		case "/identity":
			if request.URL.Query().Get("key") != "firebase-api-key" {
				t.Error("Firebase API key was not supplied to token exchange")
			}
			_ = json.NewEncoder(response).Encode(map[string]string{
				"idToken": "id-token", "refreshToken": "refresh-token", "expiresIn": "3600",
			})
		case "/bridgeRealtime/v1/control/org-1/office-main-01.json":
			if request.URL.Query().Get("auth") != "id-token" {
				t.Error("realtime stream did not use the Firebase ID token")
			}
			if request.Header.Get("Accept") != "text/event-stream" {
				t.Error("realtime stream did not request server-sent events")
			}
			response.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(response, "event: put\ndata: {\"path\":\"/\",\"data\":{\"commandId\":\"cmd-1\"}}\n\n")
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client, err := New(Options{
		SessionURL:        server.URL + "/session",
		DeviceID:          deviceID,
		BridgeKey:         bridgeKey,
		AllowInsecureHTTP: true,
		HTTPClient:        server.Client(),
		StreamHTTPClient:  server.Client(),
		IdentityURL:       server.URL + "/identity",
		RefreshURL:        server.URL + "/refresh",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	session, err := client.createSession(ctx)
	if err != nil {
		t.Fatal(err)
	}
	creds, err := client.signIn(ctx, session)
	if err != nil {
		t.Fatal(err)
	}
	signals := 0
	states := make([]bool, 0, 2)
	if err := client.stream(ctx, session, creds.IDToken, func() { signals++ }, func(value bool) {
		states = append(states, value)
	}); err != nil {
		t.Fatal(err)
	}
	if signals != 1 {
		t.Fatalf("signals = %d, want 1", signals)
	}
	if len(states) != 2 || !states[0] || states[1] {
		t.Fatalf("connection states = %v, want [true false]", states)
	}
}

func TestClientRejectsNonLoopbackDevelopmentHTTP(t *testing.T) {
	_, err := New(Options{
		SessionURL:        "http://example.com/session",
		DeviceID:          "office-main-01",
		BridgeKey:         "0123456789abcdef0123456789abcdef",
		AllowInsecureHTTP: true,
	})
	if err == nil {
		t.Fatal("expected non-loopback HTTP endpoint to be rejected")
	}
}
