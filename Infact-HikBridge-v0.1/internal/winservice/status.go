package winservice

import "errors"

var ErrNotInstalled = errors.New("Windows service is not installed")

type Status struct {
	State     string
	ProcessID uint32
	ExitCode  uint32
}
