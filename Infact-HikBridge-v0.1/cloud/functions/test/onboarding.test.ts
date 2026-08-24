import { describe, expect, it } from "vitest";

import { bootstrapOrganizationSchema } from "../src/onboarding/bootstrap.js";

const valid = {
  organizationId: "northwind-labs",
  organizationName: "Northwind Labs",
  timezone: "Asia/Colombo",
  branchId: "colombo",
  branchName: "Colombo HQ",
  shiftId: "NORMAL",
  shiftName: "Normal Shift",
  startTime: "08:30",
  endTime: "17:30",
  workingDays: [1, 2, 3, 4, 5],
  gracePeriodMinutes: 10,
  breakMinutes: 60,
  lateCalculationMode: "after_grace",
  missingPunchPolicy: "flag_exception",
} as const;

describe("organization onboarding input", () => {
  it("accepts a complete mandatory setup", () => {
    expect(bootstrapOrganizationSchema.parse(valid)).toEqual(valid);
  });

  it("rejects invalid timezones, duplicate weekdays, and matching shift times", () => {
    expect(bootstrapOrganizationSchema.safeParse({ ...valid, timezone: "Colombo", workingDays: [1, 1] }).success).toBe(false);
    expect(bootstrapOrganizationSchema.safeParse({ ...valid, endTime: valid.startTime }).success).toBe(false);
  });

  it("rejects unknown fields and unsafe identifiers", () => {
    expect(bootstrapOrganizationSchema.safeParse({ ...valid, organizationId: "../../other", extra: true }).success).toBe(false);
  });
});
