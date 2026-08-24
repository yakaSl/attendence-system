//go:build !windows

package winservice

import (
	"context"
	"fmt"
)

func IsWindowsService() bool { return false }

func Run(serviceName string, run func(context.Context) error) error {
	return run(context.Background())
}

func unsupported() error {
	return fmt.Errorf("Windows Service management is only supported on Windows")
}

func Install(serviceName, displayName, description, configPath string) error { return unsupported() }
func Uninstall(serviceName string) error                                     { return unsupported() }
func Start(serviceName string) error                                         { return unsupported() }
func Stop(serviceName string) error                                          { return unsupported() }
func Restart(serviceName string) error                                       { return unsupported() }
func QueryStatus(serviceName string) (Status, error)                         { return Status{}, unsupported() }
