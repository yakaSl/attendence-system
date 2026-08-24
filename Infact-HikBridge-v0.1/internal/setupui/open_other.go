//go:build !windows

package setupui

import "fmt"

func openBrowser(_ string) error {
	return fmt.Errorf("automatic browser launch is only supported on Windows")
}
