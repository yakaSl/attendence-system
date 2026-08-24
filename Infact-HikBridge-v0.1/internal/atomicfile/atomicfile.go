package atomicfile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// WriteFile writes data to a temporary sibling, flushes it, and atomically
// replaces path. Keeping the temporary file in the same directory ensures the
// replacement does not cross filesystems.
func WriteFile(path string, data []byte, perm os.FileMode) (err error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create atomic-write directory: %w", err)
	}

	tmp, err := os.CreateTemp(dir, ".hikbridge-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary file: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() {
		_ = tmp.Close()
		removeErr := os.Remove(tmpPath)
		if err == nil && removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			err = fmt.Errorf("remove temporary file: %w", removeErr)
		}
	}()

	if err := tmp.Chmod(perm); err != nil {
		return fmt.Errorf("set temporary file permissions: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fmt.Errorf("write temporary file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("flush temporary file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temporary file: %w", err)
	}
	if err := replaceFile(tmpPath, path); err != nil {
		return fmt.Errorf("replace %s: %w", filepath.Base(path), err)
	}
	return syncDirectory(dir)
}

func syncDirectory(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open directory for flush: %w", err)
	}
	defer f.Close()
	if err := f.Sync(); err != nil && !ignoreDirectorySyncError(err) {
		return fmt.Errorf("flush directory: %w", err)
	}
	return nil
}
