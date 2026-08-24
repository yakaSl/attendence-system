import { describe, expect, it } from "vitest";

import { inferDailyShift } from "../src/attendance/shift-inference.js";
import type { AttendancePunch, ShiftDefinition } from "../src/attendance/types.js";

function shift(id: string, startTime: string): ShiftDefinition {
  return {
    id,
    name: `${id} Shift`,
    startTime,
    endTime: "17:30",
    workingDays: [1, 2, 3, 4, 5, 6, 7],
    gracePeriodMinutes: 10,
    lateCalculationMode: "after_grace",
    breakMinutes: 60,
    punchMode: "first_last",
    earlyLeave: { graceMinutes: 0 },
    overtime: {
      enabled: false,
      startDelayMinutes: 0,
      minimumMinutes: 0,
      roundingMinutes: 1,
      roundingMode: "none",
    },
  };
}

function punch(id: string, occurredAt: string, direction: AttendancePunch["direction"] = "unknown"): AttendancePunch {
  return { id, occurredAt, direction };
}

describe("daily shift inference", () => {
  it("selects a clearly nearest shift with high confidence", () => {
    const result = inferDailyShift({
      date: "2026-08-24",
      timezone: "Asia/Colombo",
      shifts: [shift("MORNING", "08:30"), shift("EVENING", "14:00")],
      punches: [punch("in", "2026-08-24T02:52:00Z")],
    });
    expect(result).toMatchObject({ confidence: "high", suggestedShiftId: "MORNING" });
    expect(result.candidates[0]?.distanceMinutes).toBe(8);
  });

  it("keeps equally close shifts for HR review", () => {
    const result = inferDailyShift({
      date: "2026-08-24",
      timezone: "Asia/Colombo",
      shifts: [shift("A", "08:30"), shift("B", "10:00")],
      punches: [punch("in", "2026-08-24T03:45:00Z")],
    });
    expect(result).toMatchObject({ confidence: "low", suggestedShiftId: "A" });
    expect(result.candidates).toHaveLength(2);
  });

  it("does not use an explicit checkout as a shift-start signal", () => {
    const result = inferDailyShift({
      date: "2026-08-24",
      timezone: "Asia/Colombo",
      shifts: [shift("MORNING", "08:30")],
      punches: [punch("out", "2026-08-24T03:00:00Z", "out")],
    });
    expect(result).toMatchObject({ confidence: "none", suggestedShiftId: null });
  });
});
