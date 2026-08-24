//go:build windows

package elevation

import (
	"fmt"
	"os"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

func IsElevated() bool { return windows.GetCurrentProcessToken().IsElevated() }

// Relaunch asks Windows for administrator approval without constructing a
// PowerShell or command-shell expression from user-controlled arguments.
func Relaunch(arguments []string) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate setup executable: %w", err)
	}
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(executable)
	escaped := make([]string, len(arguments))
	for index, argument := range arguments {
		escaped[index] = syscall.EscapeArg(argument)
	}
	parameters, _ := windows.UTF16PtrFromString(strings.Join(escaped, " "))
	workingDirectory, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("locate setup working directory: %w", err)
	}
	directory, _ := windows.UTF16PtrFromString(workingDirectory)
	if err := windows.ShellExecute(0, verb, file, parameters, directory, windows.SW_SHOWNORMAL); err != nil {
		return fmt.Errorf("request administrator approval: %w", err)
	}
	return nil
}
