package setupui

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"infactsolutions/hikbridge/internal/winservice"
)

type serviceController interface {
	Install(serviceName, displayName, description, configPath string) error
	Uninstall(serviceName string) error
	Start(serviceName string) error
	Stop(serviceName string) error
	Restart(serviceName string) error
	QueryStatus(serviceName string) (winservice.Status, error)
}

type nativeServiceController struct{}

func (nativeServiceController) Install(serviceName, displayName, description, configPath string) error {
	return winservice.Install(serviceName, displayName, description, configPath)
}

func (nativeServiceController) Uninstall(serviceName string) error {
	return winservice.Uninstall(serviceName)
}

func (nativeServiceController) Start(serviceName string) error {
	return winservice.Start(serviceName)
}

func (nativeServiceController) Stop(serviceName string) error {
	return winservice.Stop(serviceName)
}

func (nativeServiceController) Restart(serviceName string) error {
	return winservice.Restart(serviceName)
}

func (nativeServiceController) QueryStatus(serviceName string) (winservice.Status, error) {
	return winservice.QueryStatus(serviceName)
}

func (app *application) serviceController() serviceController {
	if app.services != nil {
		return app.services
	}
	return nativeServiceController{}
}

type publicServiceStatus struct {
	Manageable bool   `json:"manageable"`
	Configured bool   `json:"configured"`
	Installed  bool   `json:"installed"`
	State      string `json:"state"`
	ProcessID  uint32 `json:"processId,omitempty"`
	ExitCode   uint32 `json:"exitCode,omitempty"`
}

func (app *application) serviceStatus() (publicServiceStatus, error) {
	app.mu.RLock()
	configured := app.existing != nil
	app.mu.RUnlock()
	result := publicServiceStatus{
		Manageable: app.options.ManageService,
		Configured: configured,
		State:      "not-installed",
	}
	if !app.options.ManageService {
		result.State = "unavailable"
		return result, nil
	}
	status, err := app.serviceController().QueryStatus(app.options.ServiceName)
	if errors.Is(err, winservice.ErrNotInstalled) {
		return result, nil
	}
	if err != nil {
		return publicServiceStatus{}, err
	}
	result.Installed = true
	result.State = status.State
	result.ProcessID = status.ProcessID
	result.ExitCode = status.ExitCode
	return result, nil
}

func (app *application) handleServiceStatus(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || !app.authorizeAPI(response, request) {
		return
	}
	status, err := app.serviceStatus()
	if err != nil {
		writeError(response, http.StatusInternalServerError, "Could not read the Windows service status: "+err.Error())
		return
	}
	writeJSON(response, http.StatusOK, status)
}

type serviceActionRequest struct {
	Action string `json:"action"`
}

func decodeServiceAction(request *http.Request) (serviceActionRequest, error) {
	defer request.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(request.Body, 4<<10))
	decoder.DisallowUnknownFields()
	var action serviceActionRequest
	if err := decoder.Decode(&action); err != nil {
		return serviceActionRequest{}, errors.New("Service action is invalid")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return serviceActionRequest{}, errors.New("Request contains extra data")
	}
	return action, nil
}

func (app *application) handleServiceAction(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || !app.authorizeAPI(response, request) {
		return
	}
	if !app.options.ManageService {
		writeError(response, http.StatusBadRequest, "Windows service management is disabled for this setup session.")
		return
	}
	action, err := decodeServiceAction(request)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}

	app.serviceMu.Lock()
	defer app.serviceMu.Unlock()
	controller := app.serviceController()
	current, err := app.serviceStatus()
	if err != nil {
		writeError(response, http.StatusInternalServerError, "Could not read the Windows service status: "+err.Error())
		return
	}

	message := ""
	switch action.Action {
	case "install":
		if current.Installed {
			message = "Service is already installed."
			break
		}
		if !current.Configured {
			writeError(response, http.StatusConflict, "Save a valid bridge configuration before installing the service.")
			return
		}
		err = controller.Install(app.options.ServiceName, app.options.ServiceDisplay, app.options.ServiceDescription, app.options.ConfigPath)
		message = "Service installed. It is ready to start."
	case "start":
		if !current.Installed {
			writeError(response, http.StatusConflict, "Install the service before starting it.")
			return
		}
		err = controller.Start(app.options.ServiceName)
		message = "Service started."
	case "stop":
		if !current.Installed {
			writeError(response, http.StatusConflict, "The service is not installed.")
			return
		}
		err = controller.Stop(app.options.ServiceName)
		message = "Service stopped."
	case "restart":
		if !current.Installed {
			writeError(response, http.StatusConflict, "The service is not installed.")
			return
		}
		err = controller.Restart(app.options.ServiceName)
		message = "Service restarted."
	case "uninstall":
		if !current.Installed {
			message = "Service is already uninstalled."
			break
		}
		err = controller.Uninstall(app.options.ServiceName)
		message = "Service uninstalled. Configuration and queued events were retained."
	default:
		writeError(response, http.StatusBadRequest, "Unknown service action.")
		return
	}
	if err != nil {
		writeError(response, http.StatusInternalServerError, "Could not "+action.Action+" the Windows service: "+err.Error())
		return
	}
	status, err := app.serviceStatus()
	if err != nil {
		writeError(response, http.StatusInternalServerError, "Service action completed, but status could not be refreshed: "+err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "message": message, "service": status})
}
