import { describe, expect, it } from "vitest";

import { calculateAttendance } from "../src/attendance/engine.js";
import type { AttendanceCalculationInput, ShiftDefinition } from "../src/attendance/types.js";

const timezone = "Asia/Colombo";
const normalShift: ShiftDefinition = {
  id: "NORMAL",
  name: "Normal Shift",
  startTime: "08:30",
  endTime: "17:30",
  workingDays: [1, 2, 3, 4, 5, 6, 7],
  gracePeriodMinutes: 10,
  lateCalculationMode: "after_grace",
  breakMinutes: 60,
  punchMode: "first_last",
  earlyLeave: { graceMinutes: 0 },
  overtime: {
    enabled: true,
    startDelayMinutes: 15,
    minimumMinutes: 30,
    roundingMinutes: 15,
    roundingMode: "floor",
  },
};

function at(local: string, date = "2026-08-23", zone = timezone): string {
  const suffix = zone === "Asia/Colombo" ? "+05:30" : "Z";
  return `${date}T${local}:00${suffix}`;
}

function input(overrides: Partial<AttendanceCalculationInput> = {}): AttendanceCalculationInput {
  return {
    organizationId: "org-1",
    employeeId: "EMP0012",
    date: "2026-08-23",
    timezone,
    shift: normalShift,
    punches: [
      { id: "in", occurredAt: at("08:47"), direction: "unknown" },
      { id: "out", occurredAt: at("18:22"), direction: "unknown" },
    ],
    ...overrides,
  };
}

describe("calculateAttendance", () => {
  it("calculates after-grace lateness, break time, and rounded overtime", () => {
    const result = calculateAttendance(input());
    expect(result).toMatchObject({
      firstIn: "08:47",
      lastOut: "18:22",
      lateMinutes: 7,
      earlyLeaveMinutes: 0,
      workedMinutes: 515,
      overtimeMinutes: 30,
      status: "present",
    });
    expect(result.exceptions).toContain("late_arrival");
  });

  it("supports calculating all late time from shift start", () => {
    const result = calculateAttendance(input({
      shift: { ...normalShift, lateCalculationMode: "from_shift_start" },
    }));
    expect(result.lateMinutes).toBe(17);
  });

  it("marks a single unknown punch as a missing checkout", () => {
    const result = calculateAttendance(input({
      punches: [{ id: "only", occurredAt: at("08:28"), direction: "unknown" }],
    }));
    expect(result.firstIn).toBe("08:28");
    expect(result.lastOut).toBeNull();
    expect(result.exceptions).toContain("missing_check_out");
  });

  it("uses first and last of multiple untyped punches and ignores exact duplicates", () => {
    const result = calculateAttendance(input({
      punches: [
        { id: "a", occurredAt: at("08:20"), direction: "unknown" },
        { id: "b", occurredAt: at("08:20"), direction: "unknown" },
        { id: "c", occurredAt: at("12:00"), direction: "unknown" },
        { id: "d", occurredAt: at("17:30"), direction: "unknown" },
      ],
    }));
    expect(result.firstIn).toBe("08:20");
    expect(result.lastOut).toBe("17:30");
    expect(result.exceptions).toContain("duplicate_punches_ignored");
    expect(result.sourceEventIds).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps one effective punch when an employee scans repeatedly within 60 seconds", () => {
    const result = calculateAttendance(input({
      punches: [
        { id: "first", occurredAt: "2026-08-23T08:30:00+05:30", direction: "unknown" },
        { id: "second", occurredAt: "2026-08-23T08:30:12+05:30", direction: "unknown" },
        { id: "third", occurredAt: "2026-08-23T08:30:59+05:30", direction: "unknown" },
      ],
    }));
    expect(result.firstIn).toBe("08:30");
    expect(result.lastOut).toBeNull();
    expect(result.workedMinutes).toBe(0);
    expect(result.exceptions).toContain("duplicate_punches_ignored");
    expect(result.exceptions).toContain("missing_check_out");
    expect(result.sourceEventIds).toEqual(["first", "second", "third"]);
  });

  it("accepts a later untyped scan as checkout after the duplicate window", () => {
    const result = calculateAttendance(input({
      punches: [
        { id: "in", occurredAt: "2026-08-23T08:30:00+05:30", direction: "unknown" },
        { id: "repeat", occurredAt: "2026-08-23T08:30:15+05:30", direction: "unknown" },
        { id: "out", occurredAt: "2026-08-23T17:30:00+05:30", direction: "unknown" },
      ],
    }));
    expect(result.firstIn).toBe("08:30");
    expect(result.lastOut).toBe("17:30");
    expect(result.exceptions).not.toContain("missing_check_out");
  });

  it("does not suppress opposite explicit directions inside the duplicate window", () => {
    const result = calculateAttendance(input({
      shift: { ...normalShift, punchMode: "explicit_status" },
      punches: [
        { id: "in", occurredAt: "2026-08-23T08:30:00+05:30", direction: "in" },
        { id: "out", occurredAt: "2026-08-23T08:30:20+05:30", direction: "out" },
      ],
    }));
    expect(result.firstIn).toBe("08:30");
    expect(result.lastOut).toBe("08:30");
  });

  it("honors explicit check-in and checkout status", () => {
    const result = calculateAttendance(input({
      shift: { ...normalShift, punchMode: "explicit_status" },
      punches: [
        { id: "out-early", occurredAt: at("09:00"), direction: "out" },
        { id: "in", occurredAt: at("08:31"), direction: "in" },
        { id: "unknown", occurredAt: at("12:00"), direction: "unknown" },
        { id: "out", occurredAt: at("17:40"), direction: "out" },
      ],
    }));
    expect(result.firstIn).toBe("08:31");
    expect(result.lastOut).toBe("17:40");
  });

  it("flags an explicit checkout that precedes check-in", () => {
    const result = calculateAttendance(input({
      shift: { ...normalShift, punchMode: "explicit_status" },
      punches: [
        { id: "out", occurredAt: at("08:20"), direction: "out" },
        { id: "in", occurredAt: at("08:30"), direction: "in" },
      ],
    }));
    expect(result.workedMinutes).toBe(0);
    expect(result.exceptions).toContain("invalid_punch_order");
  });

  it("attributes an overnight shift to its starting workday", () => {
    const overnight: ShiftDefinition = {
      ...normalShift,
      id: "NIGHT",
      startTime: "22:00",
      endTime: "06:00",
      breakMinutes: 30,
      overtime: { ...normalShift.overtime, enabled: false },
    };
    const result = calculateAttendance(input({
      date: "2026-08-23",
      shift: overnight,
      punches: [
        { id: "night-in", occurredAt: at("21:55"), direction: "unknown" },
        { id: "night-out", occurredAt: at("06:05", "2026-08-24"), direction: "unknown" },
      ],
    }));
    expect(result.date).toBe("2026-08-23");
    expect(result.scheduledOutAt).toBe("2026-08-24T00:30:00Z");
    expect(result.firstIn).toBe("21:55");
    expect(result.lastOut).toBe("06:05");
    expect(result.workedMinutes).toBe(460);
  });

  it.each([
    ["holiday", { holiday: { id: "new-year", name: "New Year" } }, "holiday"],
    ["leave", { leave: { id: "leave-1", type: "annual" } }, "leave"],
    ["no shift", { shift: null }, "no_shift"],
  ] as const)("handles %s without punches", (_label, overrides, status) => {
    const result = calculateAttendance(input({ punches: [], ...overrides }));
    expect(result.status).toBe(status);
  });

  it("flags work on holiday while preserving the present status", () => {
    const result = calculateAttendance(input({ holiday: { id: "holiday", name: "Holiday" } }));
    expect(result.status).toBe("present");
    expect(result.exceptions).toContain("worked_on_holiday");
  });

  it("calculates early departure after the configured tolerance", () => {
    const result = calculateAttendance(input({
      shift: { ...normalShift, earlyLeave: { graceMinutes: 5 } },
      punches: [
        { id: "in", occurredAt: at("08:30"), direction: "unknown" },
        { id: "out", occurredAt: at("17:10"), direction: "unknown" },
      ],
    }));
    expect(result.earlyLeaveMinutes).toBe(15);
    expect(result.exceptions).toContain("early_leave");
  });

  it("applies immutable corrections without mutating source punches", () => {
    const sourcePunches = [{ id: "only", occurredAt: at("08:30"), direction: "unknown" as const }];
    const result = calculateAttendance(input({
      punches: sourcePunches,
      approvedAdjustments: [{ id: "adjustment-1", kind: "set_last_out", occurredAt: at("17:35") }],
    }));
    expect(result.lastOut).toBe("17:35");
    expect(result.hasManualAdjustment).toBe(true);
    expect(result.adjustmentIds).toEqual(["adjustment-1"]);
    expect(sourcePunches).toEqual([{ id: "only", occurredAt: at("08:30"), direction: "unknown" }]);
  });

  it("applies multiple corrections in approval order", () => {
    const result = calculateAttendance(input({
      approvedAdjustments: [
        { id: "z-old", kind: "set_last_out", occurredAt: at("17:35"), approvedAt: "2026-08-23T13:00:00Z" },
        { id: "a-new", kind: "set_last_out", occurredAt: at("17:40"), approvedAt: "2026-08-23T14:00:00Z" },
      ],
    }));
    expect(result.lastOut).toBe("17:40");
  });

  it("recalculates deterministically when a delayed punch arrives", () => {
    const before = calculateAttendance(input({ punches: [
      { id: "in", occurredAt: at("08:30"), direction: "unknown" },
    ] }));
    const afterInput = input({ punches: [
      { id: "in", occurredAt: at("08:30"), direction: "unknown" },
      { id: "delayed-out", occurredAt: at("17:30"), direction: "unknown" },
    ] });
    const after = calculateAttendance(afterInput);
    expect(before.exceptions).toContain("missing_check_out");
    expect(after.exceptions).not.toContain("missing_check_out");
    expect(calculateAttendance(afterInput)).toEqual(after);
  });

  it("uses elapsed instants across a daylight-saving boundary", () => {
    const result = calculateAttendance(input({
      date: "2026-03-08",
      timezone: "America/New_York",
      shift: {
        ...normalShift,
        startTime: "00:30",
        endTime: "04:30",
        breakMinutes: 0,
        overtime: { ...normalShift.overtime, enabled: false },
      },
      punches: [
        { id: "dst-in", occurredAt: "2026-03-08T05:30:00Z", direction: "unknown" },
        { id: "dst-out", occurredAt: "2026-03-08T08:30:00Z", direction: "unknown" },
      ],
    }));
    expect(result.workedMinutes).toBe(180);
  });
});
