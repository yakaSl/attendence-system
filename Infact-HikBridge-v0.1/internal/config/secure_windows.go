//go:build windows

package config

import (
	"fmt"
	"os/exec"
	"path/filepath"
)

// SecureDirectory limits configuration, logs, and queued evidence to Local
// System and the local Administrators group. SIDs avoid localized group names.
func SecureDirectory(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve data directory: %w", err)
	}
	commands := [][]string{
		{absolute, "/inheritance:r"},
		{absolute, "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"},
	}
	for _, args := range commands {
		if output, err := exec.Command("icacls.exe", args...).CombinedOutput(); err != nil {
			return fmt.Errorf("secure data directory: %w: %s", err, string(output))
		}
	}
	return nil
}
