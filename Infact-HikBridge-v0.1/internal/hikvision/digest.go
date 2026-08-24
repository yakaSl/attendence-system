package hikvision

import (
	"bytes"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

var digestPairRE = regexp.MustCompile(`([a-zA-Z0-9_-]+)=((?:"(?:\\.|[^"])*")|[^,]+)`)

type digestChallenge struct {
	Realm            string
	Nonce            string
	Opaque           string
	OpaquePresent    bool
	Algorithm        string
	AlgorithmPresent bool
	QOP              string
	Stale            bool
}

func parseDigestChallenge(header string) (digestChallenge, error) {
	var challenge digestChallenge
	header = strings.TrimSpace(header)
	index := strings.Index(strings.ToLower(header), "digest ")
	if index < 0 {
		return challenge, fmt.Errorf("unsupported WWW-Authenticate challenge")
	}
	header = header[index+len("digest "):]
	for _, match := range digestPairRE.FindAllStringSubmatch(header, -1) {
		key := strings.ToLower(match[1])
		value := strings.TrimSpace(match[2])
		if strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) {
			if unquoted, err := strconv.Unquote(value); err == nil {
				value = unquoted
			} else {
				return challenge, fmt.Errorf("invalid quoted digest parameter %s", key)
			}
		}
		switch key {
		case "realm":
			challenge.Realm = value
		case "nonce":
			challenge.Nonce = value
		case "opaque":
			challenge.Opaque = value
			challenge.OpaquePresent = true
		case "algorithm":
			challenge.Algorithm = value
			challenge.AlgorithmPresent = true
		case "qop":
			challenge.QOP = value
		case "stale":
			challenge.Stale = strings.EqualFold(value, "true")
		}
	}
	if challenge.Nonce == "" || challenge.Realm == "" {
		return challenge, fmt.Errorf("invalid digest challenge: realm and nonce are required")
	}
	if challenge.Algorithm == "" {
		challenge.Algorithm = "MD5"
	}
	if _, err := digestHex(baseDigestAlgorithm(challenge.Algorithm), "validation"); err != nil {
		return challenge, err
	}
	if challenge.QOP != "" && selectDigestQOP(challenge.QOP) == "" {
		return challenge, fmt.Errorf("digest challenge does not support qop=auth")
	}
	return challenge, nil
}

func baseDigestAlgorithm(algorithm string) string {
	return strings.TrimSuffix(strings.ToUpper(strings.TrimSpace(algorithm)), "-SESS")
}

func digestHex(algorithm, value string) (string, error) {
	switch strings.ToUpper(algorithm) {
	case "MD5":
		hash := md5.Sum([]byte(value))
		return hex.EncodeToString(hash[:]), nil
	case "SHA-256":
		hash := sha256.Sum256([]byte(value))
		return hex.EncodeToString(hash[:]), nil
	default:
		return "", fmt.Errorf("unsupported digest algorithm %q", algorithm)
	}
}

func randomCNonce() (string, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate digest cnonce: %w", err)
	}
	return hex.EncodeToString(b), nil
}

func selectDigestQOP(qopList string) string {
	for _, candidate := range strings.Split(qopList, ",") {
		if strings.EqualFold(strings.TrimSpace(candidate), "auth") {
			return "auth"
		}
	}
	return ""
}

func quoteDigest(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return `"` + value + `"`
}

func buildDigestAuthorizationWithNonce(
	challenge digestChallenge,
	username, password, method, uri, cnonce string,
	nonceCount uint32,
) (string, error) {
	algorithm := strings.ToUpper(challenge.Algorithm)
	baseAlgorithm := baseDigestAlgorithm(algorithm)
	ha1, err := digestHex(baseAlgorithm, username+":"+challenge.Realm+":"+password)
	if err != nil {
		return "", err
	}
	if strings.HasSuffix(algorithm, "-SESS") {
		ha1, err = digestHex(baseAlgorithm, ha1+":"+challenge.Nonce+":"+cnonce)
		if err != nil {
			return "", err
		}
	}
	ha2, err := digestHex(baseAlgorithm, method+":"+uri)
	if err != nil {
		return "", err
	}

	qop := selectDigestQOP(challenge.QOP)
	nonceCountHex := fmt.Sprintf("%08x", nonceCount)
	var response string
	if qop != "" {
		response, err = digestHex(baseAlgorithm, strings.Join([]string{
			ha1, challenge.Nonce, nonceCountHex, cnonce, qop, ha2,
		}, ":"))
	} else {
		response, err = digestHex(baseAlgorithm, ha1+":"+challenge.Nonce+":"+ha2)
	}
	if err != nil {
		return "", err
	}

	parts := []string{
		"Digest username=" + quoteDigest(username),
		"realm=" + quoteDigest(challenge.Realm),
		"nonce=" + quoteDigest(challenge.Nonce),
		"uri=" + quoteDigest(uri),
		"response=" + quoteDigest(response),
	}
	if challenge.AlgorithmPresent {
		parts = append(parts, "algorithm="+challenge.Algorithm)
	}
	if challenge.OpaquePresent {
		parts = append(parts, "opaque="+quoteDigest(challenge.Opaque))
	}
	if qop != "" {
		parts = append(parts, "qop=auth", "nc="+nonceCountHex, "cnonce="+quoteDigest(cnonce))
	} else if strings.HasSuffix(algorithm, "-SESS") {
		parts = append(parts, "cnonce="+quoteDigest(cnonce))
	}
	return strings.Join(parts, ", "), nil
}

func buildDigestAuthorization(challenge digestChallenge, username, password, method, uri string) (string, error) {
	cnonce, err := randomCNonce()
	if err != nil {
		return "", err
	}
	return buildDigestAuthorizationWithNonce(challenge, username, password, method, uri, cnonce, 1)
}

type digestClient struct {
	http     *http.Client
	username string
	password string
}

func newDigestClient(client *http.Client, username, password string) *digestClient {
	return &digestClient{http: client, username: username, password: password}
}

func requestBody(req *http.Request) ([]byte, error) {
	if req.Body == nil {
		return nil, nil
	}
	b, err := io.ReadAll(req.Body)
	if closeErr := req.Body.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	return b, nil
}

func cloneRequest(req *http.Request, body []byte) *http.Request {
	clone := req.Clone(req.Context())
	if body != nil {
		clone.Body = io.NopCloser(bytes.NewReader(body))
		clone.ContentLength = int64(len(body))
		clone.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(body)), nil
		}
	}
	return clone
}

func digestHeader(headers http.Header) (string, error) {
	for _, header := range headers.Values("WWW-Authenticate") {
		if strings.Contains(strings.ToLower(header), "digest ") {
			return header, nil
		}
	}
	return "", fmt.Errorf("Hikvision returned 401 without a Digest challenge")
}

func (d *digestClient) Do(req *http.Request) (*http.Response, error) {
	body, err := requestBody(req)
	if err != nil {
		return nil, fmt.Errorf("buffer request for Digest authentication: %w", err)
	}
	// DS-K1A8503EF V1.4.1 can reject reuse of a previously issued nonce without
	// returning another WWW-Authenticate header. Start a fresh Digest exchange
	// for every request, as curl --digest does, to avoid invalid-login attempts.
	first := cloneRequest(req, body)
	first.Header.Del("Authorization")

	resp, err := d.http.Do(first)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusUnauthorized {
		return resp, nil
	}
	header, err := digestHeader(resp.Header)
	if err != nil {
		resp.Body.Close()
		return nil, err
	}
	challenge, err := parseDigestChallenge(header)
	if err != nil {
		resp.Body.Close()
		return nil, err
	}
	resp.Body.Close()

	retry := cloneRequest(req, body)
	authorization, err := buildDigestAuthorization(challenge, d.username, d.password, retry.Method, retry.URL.RequestURI())
	if err != nil {
		return nil, err
	}
	retry.Header.Set("Authorization", authorization)
	return d.http.Do(retry)
}
