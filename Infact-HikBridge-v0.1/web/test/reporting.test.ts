import { describe, expect, it } from "vitest";

import { attendanceCsv, monthlySummaryCsv, summarizeAttendance } from "../src/lib/data/reporting";
import { effectiveDeviceConnectionStatus } from "../src/lib/data/repository";
import type { AttendanceDay } from "../src/lib/data/types";

const base: AttendanceDay = {
  id: "employee-1_2026-08-01",
  employeeId: "employee-1",
  employeeCode: "EMP,001",
  employeeName: "Perera, Kasun",
  departmentId: "sales",
  departmentName: "Sales",
  branchId: "hq",
  branchName: "HQ",
  shiftId: "NORMAL",
  shiftName: "Normal",
  date: "2026-08-01",
  scheduledIn: "08:30",
  scheduledOut: "17:30",
  firstIn: "08:47",
  lastOut: "17:30",
  workedMinutes: 463,
  lateMinutes: 7,
  earlyLeaveMinutes: 0,
  overtimeMinutes: 30,
  status: "present",
  exceptions: ["late_arrival"],
  hasManualAdjustment: false,
};

describe("reporting", () => {
  it("summarizes employee attendance without losing minute precision", () => {
    const rows = summarizeAttendance([
      base,
      { ...base, id: "employee-1_2026-08-02", date: "2026-08-02", status: "absent", workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0 },
      { ...base, id: "employee-1_2026-08-03", date: "2026-08-03", status: "leave", workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0 },
    ]);
    expect(rows[0]).toMatchObject({ presentDays: 1, absentDays: 1, leaveDays: 1, lateDays: 1, totalLateMinutes: 7, overtimeMinutes: 30 });
  });

  it("escapes CSV fields and emits CRLF rows", () => {
    const csv = monthlySummaryCsv(summarizeAttendance([base]));
    expect(csv).toContain('"EMP,001","Perera, Kasun"');
    expect(csv).toContain("\r\n");
  });

  it("exports source-linked daily attendance columns", () => {
    const csv = attendanceCsv([base]);
    expect(csv).toContain("Worked Minutes");
    expect(csv).toContain('"Perera, Kasun"');
    expect(csv).toContain("late_arrival");
  });

  it("marks a silent bridge offline after missed health reports", () => {
    const now = Date.parse("2026-08-23T12:10:00Z");
    expect(effectiveDeviceConnectionStatus(true, "online", "2026-08-23T12:00:00Z", now)).toBe("offline");
    expect(effectiveDeviceConnectionStatus(true, "online", "2026-08-23T12:09:00Z", now)).toBe("online");
    expect(effectiveDeviceConnectionStatus(false, "online", "2026-08-23T12:09:00Z", now)).toBe("disabled");
  });
});
