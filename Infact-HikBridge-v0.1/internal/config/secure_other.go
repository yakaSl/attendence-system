//go:build !windows

package config

import "os"

func SecureDirectory(path string) error { return os.Chmod(path, 0700) }
