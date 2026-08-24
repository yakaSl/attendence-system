//go:build windows

package atomicfile

import "golang.org/x/sys/windows"

func replaceFile(from, to string) error {
	fromPtr, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	toPtr, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(
		fromPtr,
		toPtr,
		windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH,
	)
}

func ignoreDirectorySyncError(error) bool {
	// Windows does not support flushing a directory handle opened through
	// os.Open. MoveFileEx with WRITE_THROUGH supplies the durability boundary.
	return true
}
