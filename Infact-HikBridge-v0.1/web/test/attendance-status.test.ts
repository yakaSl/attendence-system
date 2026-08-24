import { describe, expect, it } from "vitest";

import { attendanceDisplayStatus } from "../src/lib/data/attendance-status";
import type { AttendanceDay } from "../src/lib/data/types";

function day(overrides: Partial<AttendanceDay> = {}): AttendanceDay {
  return {
    id: "employee-1_2026-08-24",
    employeeId: "employee-1",
    employeeCode: "E001",
    employeeName: "Test Employee",
    departmentId: null,
    departmentName: "Unassigned",
    branchId: "main",
    branchName: "Main",
    shiftId: "NORMAL",
    shiftName: "Normal Shift",
    date: "2026-08-24",
    scheduledIn: "08:30",
    scheduledOut: "17:30",
    scheduledOutAt: "2026-08-24T12:00:00Z",
    firstIn: "08:31",
    lastOut: null,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    status: "present",
    exceptions: ["missing_check_out"],
    hasManualAdjustment: false,
    ...overrides,
  };
}

describe("attendanceDisplayStatus", () => {
  it("shows checked in before scheduled checkout", () => {
    expect(attendanceDisplayStatus(day(), Date.parse("2026-08-24T11:59:59Z"))).toBe("checked_in");
  });

  it("shows missing punch after scheduled checkout", () => {
    expect(attendanceDisplayStatus(day(), Date.parse("2026-08-24T12:00:00Z"))).toBe("missing_punch");
  });

  it("always exposes a missing check-in", () => {
    expect(attendanceDisplayStatus(day({
      firstIn: null,
      lastOut: "17:30",
      exceptions: ["missing_check_in"],
    }), Date.parse("2026-08-24T09:00:00Z"))).toBe("missing_punch");
  });

  it("shows completed attendance as present", () => {
    expect(attendanceDisplayStatus(day({
      lastOut: "17:31",
      exceptions: [],
    }), Date.parse("2026-08-24T12:01:00Z"))).toBe("present");
  });

  it("shows a punch without an assigned shift as unscheduled", () => {
    expect(attendanceDisplayStatus(day({
      shiftId: null,
      shiftName: "Unassigned",
      scheduledIn: null,
      scheduledOut: null,
      scheduledOutAt: null,
      exceptions: ["missing_check_out", "worked_without_shift"],
    }), Date.parse("2026-08-24T12:01:00Z"))).toBe("unscheduled_punch");
  });
});
