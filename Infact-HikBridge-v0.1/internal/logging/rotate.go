package logging

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

type RotatingFile struct {
	path     string
	maxBytes int64
	backups  int
	file     *os.File
	size     int64
	mu       sync.Mutex
}

func Open(path string, maxBytes int64, backups int) (*RotatingFile, error) {
	if maxBytes <= 0 || backups <= 0 {
		return nil, fmt.Errorf("log rotation size and backup count must be positive")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	writer := &RotatingFile{path: path, maxBytes: maxBytes, backups: backups}
	if err := writer.open(); err != nil {
		return nil, err
	}
	return writer, nil
}

func (w *RotatingFile) open() error {
	file, err := os.OpenFile(w.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return err
	}
	w.file = file
	w.size = info.Size()
	return nil
}

func (w *RotatingFile) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return 0, os.ErrClosed
	}
	if w.size > 0 && w.size+int64(len(data)) > w.maxBytes {
		if err := w.rotate(); err != nil {
			return 0, err
		}
	}
	written, err := w.file.Write(data)
	w.size += int64(written)
	return written, err
}

func (w *RotatingFile) rotate() error {
	if err := w.file.Sync(); err != nil {
		return err
	}
	if err := w.file.Close(); err != nil {
		return err
	}
	w.file = nil
	oldest := w.path + "." + strconv.Itoa(w.backups)
	if err := os.Remove(oldest); err != nil && !os.IsNotExist(err) {
		return err
	}
	for index := w.backups - 1; index >= 1; index-- {
		from := w.path + "." + strconv.Itoa(index)
		to := w.path + "." + strconv.Itoa(index+1)
		if err := os.Remove(to); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := os.Rename(from, to); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	first := w.path + ".1"
	if err := os.Remove(first); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(w.path, first); err != nil && !os.IsNotExist(err) {
		return err
	}
	return w.open()
}

func (w *RotatingFile) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}
