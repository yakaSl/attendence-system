package logging

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRotatingFileBoundsActiveLogAndKeepsBackups(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "hikbridge.log")
	writer, err := Open(path, 32, 2)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 5; index++ {
		if _, err := writer.Write([]byte(strings.Repeat(string(rune('a'+index)), 20))); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"hikbridge.log", "hikbridge.log.1", "hikbridge.log.2"} {
		if _, err := os.Stat(filepath.Join(filepath.Dir(path), name)); err != nil {
			t.Fatalf("expected %s: %v", name, err)
		}
	}
	if _, err := os.Stat(path + ".3"); !os.IsNotExist(err) {
		t.Fatalf("unexpected third backup: %v", err)
	}
}
