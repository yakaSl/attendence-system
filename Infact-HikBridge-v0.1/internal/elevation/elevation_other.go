//go:build !windows

package elevation

import "errors"

func IsElevated() bool { return true }
func Relaunch(_ []string) error {
	return errors.New("administrator relaunch is only supported on Windows")
}
