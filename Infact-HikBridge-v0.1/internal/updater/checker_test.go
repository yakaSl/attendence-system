package updater

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestCheckReportsNewRelease(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("User-Agent") != "Infact-HikBridge/0.1.2" {
			t.Fatalf("unexpected user agent %q", request.Header.Get("User-Agent"))
		}
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, `{"version":"0.2.0","downloadUrl":"https://downloads.example.com/Infact-HikBridge-Setup-0.2.0.exe","releaseNotesUrl":"https://pulse.example.com/releases/0.2.0"}`)
	}))
	defer server.Close()

	checker, err := New(Options{ManifestURL: server.URL, CurrentVersion: "0.1.2", AllowInsecureHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	result, err := checker.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !result.UpdateAvailable || result.CurrentVersion != "0.1.2" || result.LatestVersion != "0.2.0" {
		t.Fatalf("unexpected update result: %+v", result)
	}
}

func TestCheckDoesNotDowngradeOrRepeatInstalledRelease(t *testing.T) {
	for _, latest := range []string{"0.1.2", "0.1.1", "0.1.2-beta.3"} {
		t.Run(latest, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				fmt.Fprintf(response, `{"version":%q,"downloadUrl":"https://downloads.example.com/hikbridge.exe"}`, latest)
			}))
			defer server.Close()
			checker, err := New(Options{ManifestURL: server.URL, CurrentVersion: "0.1.2", AllowInsecureHTTP: true})
			if err != nil {
				t.Fatal(err)
			}
			result, err := checker.Check(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if result.UpdateAvailable {
				t.Fatalf("%s should not replace 0.1.2", latest)
			}
		})
	}
}

func TestSemanticPrereleaseOrdering(t *testing.T) {
	ordered := []string{"1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"}
	for index := 1; index < len(ordered); index++ {
		left, err := parseSemanticVersion(ordered[index-1])
		if err != nil {
			t.Fatal(err)
		}
		right, err := parseSemanticVersion(ordered[index])
		if err != nil {
			t.Fatal(err)
		}
		if compareSemanticVersions(left, right) >= 0 {
			t.Fatalf("expected %s before %s", ordered[index-1], ordered[index])
		}
	}
}

func TestCheckerRejectsInsecureReleaseLocations(t *testing.T) {
	if _, err := New(Options{ManifestURL: "http://updates.example.com/latest.json", CurrentVersion: "0.1.2"}); err == nil {
		t.Fatal("insecure manifest URL was accepted")
	}

	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"version":"0.2.0","downloadUrl":"http://downloads.example.com/hikbridge.exe"}`)),
			Request:    request,
		}, nil
	})}
	checker, err := New(Options{ManifestURL: "https://updates.example.com/latest.json", CurrentVersion: "0.1.2", HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := checker.Check(context.Background()); err == nil {
		t.Fatal("insecure download URL was accepted")
	}
}

func TestCheckerRejectsOversizedOrUnknownManifestData(t *testing.T) {
	for name, payload := range map[string]string{
		"oversized": strings.Repeat("x", maxManifestBytes+1),
		"unknown":   `{"version":"0.2.0","downloadUrl":"https://downloads.example.com/hikbridge.exe","unexpected":true}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				fmt.Fprint(response, payload)
			}))
			defer server.Close()
			checker, err := New(Options{ManifestURL: server.URL, CurrentVersion: "0.1.2", AllowInsecureHTTP: true})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := checker.Check(context.Background()); err == nil {
				t.Fatal("invalid manifest was accepted")
			}
		})
	}
}
