package setupui

import (
	"context"
	"net/http"
	"time"

	"infactsolutions/hikbridge/internal/updater"
)

type updateChecker interface {
	Check(context.Context) (updater.Result, error)
}

type publicUpdateStatus struct {
	Configured      bool   `json:"configured"`
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion,omitempty"`
	UpdateAvailable bool   `json:"updateAvailable"`
	DownloadURL     string `json:"downloadUrl,omitempty"`
	ReleaseNotesURL string `json:"releaseNotesUrl,omitempty"`
}

func (app *application) handleUpdate(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || !app.authorizeAPI(response, request) {
		return
	}
	if app.updates == nil {
		writeJSON(response, http.StatusOK, publicUpdateStatus{
			Configured:     false,
			CurrentVersion: app.options.Version,
		})
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 12*time.Second)
	defer cancel()
	result, err := app.updates.Check(ctx)
	if err != nil {
		writeError(response, http.StatusBadGateway, "Could not check for HikBridge updates. Verify this PC's internet connection and try again.")
		return
	}
	writeJSON(response, http.StatusOK, publicUpdateStatus{
		Configured:      true,
		CurrentVersion:  result.CurrentVersion,
		LatestVersion:   result.LatestVersion,
		UpdateAvailable: result.UpdateAvailable,
		DownloadURL:     result.DownloadURL,
		ReleaseNotesURL: result.ReleaseNotesURL,
	})
}
