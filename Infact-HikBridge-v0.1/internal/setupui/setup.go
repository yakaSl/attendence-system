package setupui

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"infactsolutions/hikbridge/internal/config"
	"infactsolutions/hikbridge/internal/hikvision"
	"infactsolutions/hikbridge/internal/syncer"
	"infactsolutions/hikbridge/internal/winservice"
)

type Options struct {
	ConfigPath         string
	ListenAddress      string
	Version            string
	OpenBrowser        bool
	ManageService      bool
	ServiceName        string
	ServiceDisplay     string
	ServiceDescription string
}

type deviceForm struct {
	Address    string `json:"address"`
	Port       int    `json:"port"`
	UseHTTPS   bool   `json:"useHttps"`
	Username   string `json:"username"`
	Password   string `json:"password"`
	DeviceName string `json:"deviceName"`
	TimeZone   string `json:"timeZone"`
}

type cloudForm struct {
	Enabled          bool   `json:"enabled"`
	InstallationCode string `json:"installationCode"`
	BridgeCredential string `json:"bridgeCredential"`
	IngestURL        string `json:"ingestUrl"`
}

type serviceForm struct {
	PollIntervalSeconds int `json:"pollIntervalSeconds"`
}

type setupForm struct {
	Device  deviceForm  `json:"device"`
	Cloud   cloudForm   `json:"cloud"`
	Service serviceForm `json:"service"`
}

type publicState struct {
	Configured          bool   `json:"configured"`
	Version             string `json:"version"`
	Address             string `json:"address"`
	Port                int    `json:"port"`
	UseHTTPS            bool   `json:"useHttps"`
	Username            string `json:"username"`
	HasDevicePassword   bool   `json:"hasDevicePassword"`
	DeviceName          string `json:"deviceName"`
	TimeZone            string `json:"timeZone"`
	CloudEnabled        bool   `json:"cloudEnabled"`
	InstallationCode    string `json:"installationCode"`
	HasBridgeCredential bool   `json:"hasBridgeCredential"`
	IngestURL           string `json:"ingestUrl"`
	PollIntervalSeconds int    `json:"pollIntervalSeconds"`
}

type application struct {
	options      Options
	existing     *config.Config
	services     serviceController
	launchToken  string
	sessionToken string
	csrfToken    string
	cspNonce     string
	baseURL      string
	shutdown     func()
	mu           sync.RWMutex
	serviceMu    sync.Mutex
}

func randomToken(bytes int) (string, error) {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func Run(ctx context.Context, options Options) error {
	if options.ConfigPath == "" {
		options.ConfigPath = config.DefaultPath()
	}
	if options.ListenAddress == "" {
		options.ListenAddress = "127.0.0.1:8766"
	}
	host, _, err := net.SplitHostPort(options.ListenAddress)
	if err != nil || host != "127.0.0.1" {
		return errors.New("setup must listen on an explicit 127.0.0.1:port address")
	}
	listener, err := net.Listen("tcp4", options.ListenAddress)
	if err != nil {
		return fmt.Errorf("start local setup server: %w", err)
	}
	defer listener.Close()
	launchToken, err := randomToken(32)
	if err != nil {
		return fmt.Errorf("create setup launch token: %w", err)
	}
	sessionToken, err := randomToken(32)
	if err != nil {
		return fmt.Errorf("create setup session: %w", err)
	}
	csrfToken, err := randomToken(32)
	if err != nil {
		return fmt.Errorf("create setup CSRF token: %w", err)
	}
	cspNonce, err := randomToken(18)
	if err != nil {
		return fmt.Errorf("create setup CSP nonce: %w", err)
	}
	var existing *config.Config
	if loaded, loadErr := config.Load(options.ConfigPath); loadErr == nil {
		existing = loaded
	} else if !errors.Is(loadErr, os.ErrNotExist) {
		return fmt.Errorf("load existing configuration: %w", loadErr)
	}
	actualAddress := listener.Addr().String()
	app := &application{
		options:      options,
		existing:     existing,
		services:     nativeServiceController{},
		launchToken:  launchToken,
		sessionToken: sessionToken,
		csrfToken:    csrfToken,
		cspNonce:     cspNonce,
		baseURL:      "http://" + actualAddress,
	}
	server := &http.Server{
		Handler:           app.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      90 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	shutdownOnce := sync.Once{}
	app.shutdown = func() {
		shutdownOnce.Do(func() {
			go func() {
				time.Sleep(150 * time.Millisecond)
				shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				_ = server.Shutdown(shutdownCtx)
			}()
		})
	}
	go func() {
		<-ctx.Done()
		app.shutdown()
	}()
	launchURL := app.baseURL + "/?token=" + url.QueryEscape(launchToken)
	fmt.Println("Infact HikBridge setup:", launchURL)
	if options.OpenBrowser {
		if err := openBrowser(launchURL); err != nil {
			fmt.Fprintln(os.Stderr, "Could not open the browser automatically:", err)
		}
	}
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("local setup server stopped: %w", err)
	}
	return nil
}

func (app *application) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", app.handlePage)
	mux.HandleFunc("/favicon.ico", func(response http.ResponseWriter, _ *http.Request) { response.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("/api/state", app.handleState)
	mux.HandleFunc("/api/service", app.handleServiceStatus)
	mux.HandleFunc("/api/service-action", app.handleServiceAction)
	mux.HandleFunc("/api/test-device", app.handleTestDevice)
	mux.HandleFunc("/api/test-cloud", app.handleTestCloud)
	mux.HandleFunc("/api/save", app.handleSave)
	mux.HandleFunc("/api/quit", app.handleQuit)
	return app.loopbackOnly(mux)
}

func (app *application) loopbackOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		host, _, err := net.SplitHostPort(request.RemoteAddr)
		ip := net.ParseIP(host)
		if err != nil || ip == nil || !ip.IsLoopback() {
			http.Error(response, "local access only", http.StatusForbidden)
			return
		}
		if request.Host != strings.TrimPrefix(app.baseURL, "http://") {
			http.Error(response, "invalid setup host", http.StatusMisdirectedRequest)
			return
		}
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("Referrer-Policy", "no-referrer")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("X-Frame-Options", "DENY")
		response.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		response.Header().Set("Content-Security-Policy", fmt.Sprintf("default-src 'none'; script-src 'nonce-%s'; style-src 'nonce-%s'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", app.cspNonce, app.cspNonce))
		next.ServeHTTP(response, request)
	})
}

func secureEqual(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func (app *application) authenticated(request *http.Request) bool {
	cookie, err := request.Cookie("hikbridge_setup")
	return err == nil && secureEqual(cookie.Value, app.sessionToken)
}

func (app *application) authorizeAPI(response http.ResponseWriter, request *http.Request) bool {
	if !app.authenticated(request) {
		writeError(response, http.StatusUnauthorized, "Setup session is not authorized. Reopen setup from the local application.")
		return false
	}
	if request.Method == http.MethodPost {
		if request.Header.Get("Origin") != app.baseURL || !secureEqual(request.Header.Get("X-HikBridge-CSRF"), app.csrfToken) {
			writeError(response, http.StatusForbidden, "The setup request could not be verified.")
			return false
		}
	}
	return true
}

func (app *application) handlePage(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if token := request.URL.Query().Get("token"); token != "" {
		app.mu.Lock()
		validToken := app.launchToken != "" && secureEqual(token, app.launchToken)
		if validToken {
			app.launchToken = ""
		}
		app.mu.Unlock()
		if !validToken {
			http.Error(response, "invalid setup token", http.StatusForbidden)
			return
		}
		http.SetCookie(response, &http.Cookie{
			Name: "hikbridge_setup", Value: app.sessionToken, Path: "/",
			HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 60 * 60,
		})
		http.Redirect(response, request, "/", http.StatusSeeOther)
		return
	}
	if !app.authenticated(request) {
		http.Error(response, "Open setup from the Infact HikBridge application.", http.StatusUnauthorized)
		return
	}
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := setupPage.Execute(response, map[string]string{"Nonce": app.cspNonce, "CSRF": app.csrfToken, "Version": app.options.Version}); err != nil {
		http.Error(response, "render setup", http.StatusInternalServerError)
	}
}

func (app *application) handleState(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || !app.authorizeAPI(response, request) {
		return
	}
	writeJSON(response, http.StatusOK, app.state())
}

func (app *application) state() publicState {
	app.mu.RLock()
	defer app.mu.RUnlock()
	state := publicState{Version: app.options.Version, Address: "192.168.1.64", Port: 80, Username: "admin", TimeZone: "Asia/Colombo", PollIntervalSeconds: 5}
	if app.existing == nil {
		return state
	}
	cfg := app.existing
	parsed, _ := url.Parse(cfg.Hikvision.BaseURL)
	state.Configured = true
	state.Address = parsed.Hostname()
	state.UseHTTPS = parsed.Scheme == "https"
	if port, err := strconv.Atoi(parsed.Port()); err == nil {
		state.Port = port
	} else if state.UseHTTPS {
		state.Port = 443
	}
	state.Username = cfg.Hikvision.Username
	state.HasDevicePassword = cfg.Hikvision.Password != ""
	state.DeviceName = cfg.Hikvision.DeviceName
	state.TimeZone = cfg.Hikvision.TimeZone
	state.CloudEnabled = cfg.Cloud.Enabled
	state.InstallationCode = cfg.Hikvision.DeviceID
	state.HasBridgeCredential = cfg.Cloud.BridgeKey != ""
	state.IngestURL = cfg.Cloud.IngestURL
	state.PollIntervalSeconds = cfg.Service.PollIntervalSeconds
	return state
}

func decodeForm(request *http.Request) (setupForm, error) {
	defer request.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(request.Body, 64<<10))
	decoder.DisallowUnknownFields()
	var form setupForm
	if err := decoder.Decode(&form); err != nil {
		return setupForm{}, errors.New("Request fields are invalid")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return setupForm{}, errors.New("Request contains extra data")
	}
	return form, nil
}

func (app *application) buildConfig(form setupForm) (*config.Config, error) {
	app.mu.RLock()
	existing := app.existing
	app.mu.RUnlock()
	password := form.Device.Password
	bridgeCredential := form.Cloud.BridgeCredential
	if existing != nil {
		if password == "" {
			password = existing.Hikvision.Password
		}
		if bridgeCredential == "" {
			bridgeCredential = existing.Cloud.BridgeKey
		}
	}
	address := strings.Trim(strings.TrimSpace(form.Device.Address), "[]")
	if address == "" || strings.ContainsAny(address, "/?#@") {
		return nil, errors.New("Device IP address or host name is invalid")
	}
	if form.Device.Port < 1 || form.Device.Port > 65535 {
		return nil, errors.New("Device port must be between 1 and 65535")
	}
	scheme := "http"
	if form.Device.UseHTTPS {
		scheme = "https"
	}
	deviceID := strings.TrimSpace(form.Cloud.InstallationCode)
	dataDir := filepath.Dir(app.options.ConfigPath)
	value := &config.Config{
		Service: config.ServiceConfig{
			PollIntervalSeconds: form.Service.PollIntervalSeconds,
			LocalStatusAddress:  "127.0.0.1:8765",
			DataDir:             dataDir,
		},
		Hikvision: config.HikvisionConfig{
			DeviceID:   deviceID,
			DeviceName: strings.TrimSpace(form.Device.DeviceName),
			BaseURL:    (&url.URL{Scheme: scheme, Host: net.JoinHostPort(address, strconv.Itoa(form.Device.Port))}).String(),
			Username:   strings.TrimSpace(form.Device.Username),
			Password:   password,
			TimeZone:   strings.TrimSpace(form.Device.TimeZone),
		},
		Cloud: config.CloudConfig{
			Enabled:   form.Cloud.Enabled,
			IngestURL: strings.TrimSpace(form.Cloud.IngestURL),
			BridgeKey: bridgeCredential,
		},
	}
	if existing != nil {
		value.Service.InitialLookbackHours = existing.Service.InitialLookbackHours
		value.Service.OverlapSeconds = existing.Service.OverlapSeconds
		value.Service.SyncIntervalSeconds = existing.Service.SyncIntervalSeconds
		value.Service.StatusIntervalSeconds = existing.Service.StatusIntervalSeconds
		value.Service.LogMaxMegabytes = existing.Service.LogMaxMegabytes
		value.Service.LogBackups = existing.Service.LogBackups
		value.Service.SyncedRetentionDays = existing.Service.SyncedRetentionDays
		value.Hikvision.PageSize = existing.Hikvision.PageSize
		value.Hikvision.RequestTimeoutSeconds = existing.Hikvision.RequestTimeoutSeconds
		value.Hikvision.RetryCount = existing.Hikvision.RetryCount
		value.Cloud.BatchSize = existing.Cloud.BatchSize
		value.Cloud.RequestTimeoutSeconds = existing.Cloud.RequestTimeoutSeconds
		value.Cloud.AllowInsecureHTTP = existing.Cloud.AllowInsecureHTTP
	}
	value.ApplyDefaults()
	if err := value.Validate(); err != nil {
		return nil, err
	}
	return value, nil
}

func (app *application) handleTestDevice(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || !app.authorizeAPI(response, request) {
		return
	}
	form, err := decodeForm(request)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	form.Cloud.Enabled = false
	cfg, err := app.buildConfig(form)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	location, _ := cfg.DeviceLocation()
	client := hikvision.New(hikvision.Options{
		BaseURL: cfg.Hikvision.BaseURL, DeviceID: cfg.Hikvision.DeviceID,
		Username: cfg.Hikvision.Username, Password: cfg.Hikvision.Password,
		PageSize: cfg.Hikvision.PageSize, Location: location,
		Timeout:    time.Duration(cfg.Hikvision.RequestTimeoutSeconds) * time.Second,
		RetryCount: cfg.Hikvision.RetryCount,
	})
	ctx, cancel := context.WithTimeout(request.Context(), 45*time.Second)
	defer cancel()
	info, err := client.DeviceInfo(ctx)
	if err != nil {
		writeError(response, http.StatusBadGateway, "Device connection failed: "+err.Error())
		return
	}
	users, err := client.SearchUsers(ctx)
	if err != nil {
		writeError(response, http.StatusBadGateway, "Device connected, but users could not be read: "+err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok": true, "model": info.Model, "serial": info.SerialNumber,
		"firmware": info.FirmwareVersion, "users": len(users),
	})
}

func (app *application) handleTestCloud(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || !app.authorizeAPI(response, request) {
		return
	}
	form, err := decodeForm(request)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	form.Cloud.Enabled = true
	cfg, err := app.buildConfig(form)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	client, err := syncer.New(syncer.Options{
		URL: cfg.Cloud.IngestURL, DeviceID: cfg.Hikvision.DeviceID,
		BridgeKey:         cfg.Cloud.BridgeKey,
		Timeout:           time.Duration(cfg.Cloud.RequestTimeoutSeconds) * time.Second,
		AllowInsecureHTTP: cfg.Cloud.AllowInsecureHTTP, AgentVersion: app.options.Version,
	})
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 30*time.Second)
	defer cancel()
	result, err := client.Probe(ctx)
	if err != nil {
		writeError(response, http.StatusBadGateway, "Cloud connection failed: "+err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok": true, "organizationId": result.OrganizationID,
		"branchId": result.BranchID, "deviceId": result.DeviceID,
	})
}

func (app *application) handleSave(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || !app.authorizeAPI(response, request) {
		return
	}
	form, err := decodeForm(request)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	cfg, err := app.buildConfig(form)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.MkdirAll(cfg.Service.DataDir, 0700); err != nil {
		writeError(response, http.StatusInternalServerError, "Could not create the data directory: "+err.Error())
		return
	}
	if err := config.SecureDirectory(cfg.Service.DataDir); err != nil {
		writeError(response, http.StatusInternalServerError, "Could not secure the data directory: "+err.Error())
		return
	}
	if err := config.Save(app.options.ConfigPath, cfg); err != nil {
		writeError(response, http.StatusInternalServerError, "Could not save configuration: "+err.Error())
		return
	}
	serviceState := "configuration saved"
	if app.options.ManageService {
		app.serviceMu.Lock()
		defer app.serviceMu.Unlock()
		status, statusErr := app.serviceController().QueryStatus(app.options.ServiceName)
		if errors.Is(statusErr, winservice.ErrNotInstalled) {
			if err := app.serviceController().Install(app.options.ServiceName, app.options.ServiceDisplay, app.options.ServiceDescription, app.options.ConfigPath); err != nil {
				writeError(response, http.StatusInternalServerError, "Configuration was saved, but the Windows service could not be installed: "+err.Error())
				return
			}
			if err := app.serviceController().Start(app.options.ServiceName); err != nil {
				writeError(response, http.StatusInternalServerError, "Configuration was saved, but the Windows service could not be started: "+err.Error())
				return
			}
			serviceState = "installed and running"
		} else if statusErr != nil {
			writeError(response, http.StatusInternalServerError, "Configuration was saved, but the Windows service status could not be read: "+statusErr.Error())
			return
		} else if status.State == "running" {
			if err := app.serviceController().Restart(app.options.ServiceName); err != nil {
				writeError(response, http.StatusInternalServerError, "Configuration was saved, but the Windows service could not be restarted: "+err.Error())
				return
			}
			serviceState = "restarted with the new configuration"
		} else {
			if err := app.serviceController().Start(app.options.ServiceName); err != nil {
				writeError(response, http.StatusInternalServerError, "Configuration was saved, but the Windows service could not be started: "+err.Error())
				return
			}
			serviceState = "started with the new configuration"
		}
	}
	app.mu.Lock()
	app.existing = cfg
	app.mu.Unlock()
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "service": serviceState})
}

func (app *application) handleQuit(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || !app.authorizeAPI(response, request) {
		return
	}
	writeJSON(response, http.StatusOK, map[string]bool{"ok": true})
	app.shutdown()
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeError(response http.ResponseWriter, status int, message string) {
	writeJSON(response, status, map[string]string{"error": message})
}

var setupPage = template.Must(template.New("setup").Parse(pageHTML))
