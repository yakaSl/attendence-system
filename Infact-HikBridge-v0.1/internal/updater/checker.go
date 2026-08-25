package updater

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const maxManifestBytes = 64 << 10

var semanticVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)

type Options struct {
	ManifestURL       string
	CurrentVersion    string
	Timeout           time.Duration
	AllowInsecureHTTP bool
	HTTPClient        *http.Client
}

type Result struct {
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`
	UpdateAvailable bool   `json:"updateAvailable"`
	DownloadURL     string `json:"downloadUrl,omitempty"`
	ReleaseNotesURL string `json:"releaseNotesUrl,omitempty"`
}

type releaseManifest struct {
	Version         string `json:"version"`
	DownloadURL     string `json:"downloadUrl"`
	ReleaseNotesURL string `json:"releaseNotesUrl,omitempty"`
}

type Checker struct {
	manifestURL      *url.URL
	currentVersion   semanticVersion
	currentVersionID string
	allowInsecure    bool
	client           *http.Client
}

func New(options Options) (*Checker, error) {
	current, err := parseSemanticVersion(options.CurrentVersion)
	if err != nil {
		return nil, fmt.Errorf("current version: %w", err)
	}
	manifestURL, err := parseWebURL(options.ManifestURL, options.AllowInsecureHTTP)
	if err != nil {
		return nil, fmt.Errorf("update manifest URL: %w", err)
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	return &Checker{
		manifestURL:      manifestURL,
		currentVersion:   current,
		currentVersionID: options.CurrentVersion,
		allowInsecure:    options.AllowInsecureHTTP,
		client:           client,
	}, nil
}

func (checker *Checker) Check(ctx context.Context) (Result, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, checker.manifestURL.String(), nil)
	if err != nil {
		return Result{}, fmt.Errorf("create update request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "Infact-HikBridge/"+checker.currentVersionID)
	response, err := checker.client.Do(request)
	if err != nil {
		return Result{}, fmt.Errorf("download update manifest: %w", err)
	}
	defer response.Body.Close()
	if _, err := parseWebURL(response.Request.URL.String(), checker.allowInsecure); err != nil {
		return Result{}, fmt.Errorf("update manifest redirect: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		return Result{}, fmt.Errorf("download update manifest: unexpected HTTP status %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxManifestBytes+1))
	if err != nil {
		return Result{}, fmt.Errorf("read update manifest: %w", err)
	}
	if len(payload) > maxManifestBytes {
		return Result{}, errors.New("update manifest exceeds 64 KiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var manifest releaseManifest
	if err := decoder.Decode(&manifest); err != nil {
		return Result{}, fmt.Errorf("decode update manifest: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return Result{}, errors.New("update manifest contains extra data")
	}
	latest, err := parseSemanticVersion(manifest.Version)
	if err != nil {
		return Result{}, fmt.Errorf("latest version: %w", err)
	}
	downloadURL, err := parseWebURL(manifest.DownloadURL, checker.allowInsecure)
	if err != nil {
		return Result{}, fmt.Errorf("update download URL: %w", err)
	}
	releaseNotesURL := ""
	if strings.TrimSpace(manifest.ReleaseNotesURL) != "" {
		parsed, parseErr := parseWebURL(manifest.ReleaseNotesURL, checker.allowInsecure)
		if parseErr != nil {
			return Result{}, fmt.Errorf("release notes URL: %w", parseErr)
		}
		releaseNotesURL = parsed.String()
	}
	return Result{
		CurrentVersion:  checker.currentVersionID,
		LatestVersion:   manifest.Version,
		UpdateAvailable: compareSemanticVersions(latest, checker.currentVersion) > 0,
		DownloadURL:     downloadURL.String(),
		ReleaseNotesURL: releaseNotesURL,
	}, nil
}

func parseWebURL(raw string, allowInsecure bool) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !parsed.IsAbs() || parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("must be an absolute web URL without user information")
	}
	if parsed.Scheme != "https" && !(allowInsecure && parsed.Scheme == "http") {
		return nil, errors.New("must use HTTPS")
	}
	return parsed, nil
}

type semanticVersion struct {
	major      uint64
	minor      uint64
	patch      uint64
	prerelease []string
}

func parseSemanticVersion(value string) (semanticVersion, error) {
	matches := semanticVersionPattern.FindStringSubmatch(strings.TrimSpace(value))
	if matches == nil {
		return semanticVersion{}, errors.New("must use semantic version format such as 1.2.3")
	}
	parts := make([]uint64, 3)
	for index := range parts {
		parsed, err := strconv.ParseUint(matches[index+1], 10, 64)
		if err != nil {
			return semanticVersion{}, errors.New("contains a number that is too large")
		}
		parts[index] = parsed
	}
	var prerelease []string
	if matches[4] != "" {
		prerelease = strings.Split(matches[4], ".")
		for _, identifier := range prerelease {
			if len(identifier) > 1 && identifier[0] == '0' && numericIdentifier(identifier) {
				return semanticVersion{}, errors.New("numeric prerelease identifiers must not contain leading zeroes")
			}
		}
	}
	return semanticVersion{major: parts[0], minor: parts[1], patch: parts[2], prerelease: prerelease}, nil
}

func compareSemanticVersions(left, right semanticVersion) int {
	for _, pair := range [][2]uint64{{left.major, right.major}, {left.minor, right.minor}, {left.patch, right.patch}} {
		if pair[0] < pair[1] {
			return -1
		}
		if pair[0] > pair[1] {
			return 1
		}
	}
	if len(left.prerelease) == 0 && len(right.prerelease) == 0 {
		return 0
	}
	if len(left.prerelease) == 0 {
		return 1
	}
	if len(right.prerelease) == 0 {
		return -1
	}
	for index := 0; index < len(left.prerelease) && index < len(right.prerelease); index++ {
		comparison := comparePrereleaseIdentifiers(left.prerelease[index], right.prerelease[index])
		if comparison != 0 {
			return comparison
		}
	}
	if len(left.prerelease) < len(right.prerelease) {
		return -1
	}
	if len(left.prerelease) > len(right.prerelease) {
		return 1
	}
	return 0
}

func comparePrereleaseIdentifiers(left, right string) int {
	leftNumeric := numericIdentifier(left)
	rightNumeric := numericIdentifier(right)
	if leftNumeric && !rightNumeric {
		return -1
	}
	if !leftNumeric && rightNumeric {
		return 1
	}
	if leftNumeric {
		if len(left) < len(right) {
			return -1
		}
		if len(left) > len(right) {
			return 1
		}
	}
	return strings.Compare(left, right)
}

func numericIdentifier(value string) bool {
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return value != ""
}
