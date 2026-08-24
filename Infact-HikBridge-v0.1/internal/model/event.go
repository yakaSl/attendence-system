package model

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

type AttendanceEvent struct {
	ID                string          `json:"id"`
	DeviceID          string          `json:"deviceId"`
	DeviceSerial      string          `json:"deviceSerial,omitempty"`
	SerialNo          int64           `json:"serialNo,omitempty"`
	EmployeeNo        string          `json:"employeeNo,omitempty"`
	Name              string          `json:"name,omitempty"`
	EventTime         time.Time       `json:"eventTime"`
	Major             int             `json:"major"`
	Minor             int             `json:"minor"`
	AttendanceStatus  string          `json:"attendanceStatus,omitempty"`
	CurrentVerifyMode string          `json:"currentVerifyMode,omitempty"`
	CardNo            string          `json:"cardNo,omitempty"`
	CardReaderNo      int             `json:"cardReaderNo,omitempty"`
	DoorNo            int             `json:"doorNo,omitempty"`
	Raw               json.RawMessage `json:"raw,omitempty"`
	ReceivedAt        time.Time       `json:"receivedAt"`
}

type ParseIssue struct {
	DeviceID string          `json:"deviceId"`
	Page     int             `json:"page"`
	Index    int             `json:"index"`
	Message  string          `json:"message"`
	Raw      json.RawMessage `json:"raw"`
}

func NewEventID(deviceID string, serialNo int64, eventTime time.Time, employeeNo string, major, minor int) string {
	s := fmt.Sprintf("%s|%d|%s|%s|%d|%d", deviceID, serialNo, eventTime.UTC().Format(time.RFC3339Nano), employeeNo, major, minor)
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
