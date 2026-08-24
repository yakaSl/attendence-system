//go:build windows

package winservice

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func IsWindowsService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

type handler struct{ run func(context.Context) error }

func (h *handler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.run(ctx) }()
	status <- svc.Status{State: svc.Running, Accepts: accepted}
	for {
		select {
		case err := <-done:
			status <- svc.Status{State: svc.StopPending}
			if err != nil {
				return true, 1
			}
			return false, 0
		case request, ok := <-requests:
			if !ok {
				cancel()
				return true, 2
			}
			switch request.Cmd {
			case svc.Interrogate:
				status <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				select {
				case err := <-done:
					if err != nil {
						return true, 1
					}
					return false, 0
				case <-time.After(20 * time.Second):
					return true, 3
				}
			}
		}
	}
}

func Run(serviceName string, run func(context.Context) error) error {
	return svc.Run(serviceName, &handler{run: run})
}

func Install(serviceName, displayName, description, configPath string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	configPath, err = filepath.Abs(configPath)
	if err != nil {
		return fmt.Errorf("resolve service configuration path: %w", err)
	}
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	if existing, err := manager.OpenService(serviceName); err == nil {
		existing.Close()
		return fmt.Errorf("service %s already exists", serviceName)
	} else if !errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return fmt.Errorf("check existing service: %w", err)
	}
	service, err := manager.CreateService(serviceName, executable, mgr.Config{
		DisplayName: displayName,
		Description: description,
		StartType:   mgr.StartAutomatic,
	}, "run", "--config", configPath)
	if err != nil {
		return err
	}
	defer service.Close()
	recovery := []mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 15 * time.Second},
		{Type: mgr.ServiceRestart, Delay: time.Minute},
	}
	if err := service.SetRecoveryActions(recovery, uint32((24 * time.Hour).Seconds())); err != nil {
		_ = service.Delete()
		return fmt.Errorf("configure service recovery: %w", err)
	}
	if err := service.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		_ = service.Delete()
		return fmt.Errorf("configure non-crash service recovery: %w", err)
	}
	return nil
}

func openService(serviceName string) (*mgr.Mgr, *mgr.Service, error) {
	manager, err := mgr.Connect()
	if err != nil {
		return nil, nil, err
	}
	service, err := manager.OpenService(serviceName)
	if err != nil {
		manager.Disconnect()
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return nil, nil, fmt.Errorf("%w: %s", ErrNotInstalled, serviceName)
		}
		return nil, nil, err
	}
	return manager, service, nil
}

func waitForState(service *mgr.Service, desired svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		status, err := service.Query()
		if err != nil {
			return err
		}
		if status.State == desired {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for service state %s", stateName(desired))
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func Start(serviceName string) error {
	manager, service, err := openService(serviceName)
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	defer service.Close()
	status, err := service.Query()
	if err != nil {
		return err
	}
	if status.State == svc.Running {
		return nil
	}
	if err := service.Start(); err != nil {
		return err
	}
	return waitForState(service, svc.Running, 30*time.Second)
}

func stopService(service *mgr.Service) error {
	status, err := service.Query()
	if err != nil {
		return err
	}
	if status.State == svc.Stopped {
		return nil
	}
	if _, err := service.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
		return err
	}
	return waitForState(service, svc.Stopped, 30*time.Second)
}

func Stop(serviceName string) error {
	manager, service, err := openService(serviceName)
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	defer service.Close()
	return stopService(service)
}

func Restart(serviceName string) error {
	manager, service, err := openService(serviceName)
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	defer service.Close()
	if err := stopService(service); err != nil {
		return err
	}
	if err := service.Start(); err != nil {
		return err
	}
	return waitForState(service, svc.Running, 30*time.Second)
}

func QueryStatus(serviceName string) (Status, error) {
	manager, service, err := openService(serviceName)
	if err != nil {
		return Status{}, err
	}
	defer manager.Disconnect()
	defer service.Close()
	status, err := service.Query()
	if err != nil {
		return Status{}, err
	}
	return Status{
		State:     stateName(status.State),
		ProcessID: status.ProcessId,
		ExitCode:  status.Win32ExitCode,
	}, nil
}

func Uninstall(serviceName string) error {
	manager, service, err := openService(serviceName)
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	defer service.Close()
	if err := stopService(service); err != nil {
		return fmt.Errorf("stop service before removal: %w", err)
	}
	return service.Delete()
}

func stateName(state svc.State) string {
	switch state {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "start-pending"
	case svc.StopPending:
		return "stop-pending"
	case svc.Running:
		return "running"
	case svc.ContinuePending:
		return "continue-pending"
	case svc.PausePending:
		return "pause-pending"
	case svc.Paused:
		return "paused"
	default:
		return fmt.Sprintf("unknown-%d", state)
	}
}
