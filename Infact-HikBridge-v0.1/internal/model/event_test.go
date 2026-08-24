package model

import (
	"testing"
	"time"
)

func TestNewEventIDIsDeterministic(t *testing.T) {
	timestamp := time.Date(2026, 8, 23, 8, 47, 13, 0, time.FixedZone("LKT", 5*60*60+30*60))
	first := NewEventID("office-main-01", 4101, timestamp, "17", 5, 75)
	second := NewEventID("office-main-01", 4101, timestamp.UTC(), "17", 5, 75)
	if first != second {
		t.Fatalf("same instant produced different IDs: %s != %s", first, second)
	}
	if len(first) != 64 {
		t.Fatalf("ID length = %d", len(first))
	}
	changed := NewEventID("office-main-01", 4102, timestamp, "17", 5, 75)
	if changed == first {
		t.Fatal("different serial number produced the same ID")
	}
}
