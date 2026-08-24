package model

import "time"

type DeviceCommandType string

const (
	CommandUpsertUser        DeviceCommandType = "upsert_user"
	CommandEnrollFingerprint DeviceCommandType = "enroll_fingerprint"
)

type DeviceCommand struct {
	ID        string             `json:"id"`
	Type      DeviceCommandType  `json:"type"`
	IssuedAt  time.Time          `json:"issuedAt"`
	ExpiresAt time.Time          `json:"expiresAt"`
	Payload   UserCommandPayload `json:"payload"`
}

type UserCommandPayload struct {
	EmployeeID    string `json:"employeeId"`
	EmployeeNo    string `json:"employeeNo"`
	Name          string `json:"name"`
	FingerPrintID int    `json:"fingerPrintId,omitempty"`
}

type CommandResult struct {
	CommandID string               `json:"commandId"`
	State     string               `json:"state"`
	Code      string               `json:"code,omitempty"`
	Message   string               `json:"message,omitempty"`
	Output    *CommandResultOutput `json:"output,omitempty"`
}

type CommandResultOutput struct {
	EmployeeNo    string `json:"employeeNo,omitempty"`
	FingerPrintID int    `json:"fingerPrintId,omitempty"`
	Quality       int    `json:"quality,omitempty"`
}
