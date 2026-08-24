import { describe, expect, it } from "vitest";

import { createBranchSchema, deleteBranchSchema } from "../src/branches/management.js";
import { createDepartmentSchema } from "../src/departments/management.js";
import {
  createEmployeeSchema,
  requestFingerprintEnrollmentSchema,
  updateEmployeeDepartmentSchema,
} from "../src/employees/management.js";
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

describe("branch creation input", () => {
  it("accepts an organization-scoped branch", () => {
    expect(createBranchSchema.parse({
      organizationId: "northwind-labs",
      branchId: "kandy-office",
      name: "Kandy Office",
    })).toEqual({
      organizationId: "northwind-labs",
      branchId: "kandy-office",
      name: "Kandy Office",
    });
  });

  it("rejects unsafe identifiers and unknown fields", () => {
    expect(createBranchSchema.safeParse({
      organizationId: "northwind-labs",
      branchId: "../kandy",
      name: "Kandy Office",
      status: "active",
    }).success).toBe(false);
  });

  it("accepts a scoped branch deletion and department", () => {
    expect(deleteBranchSchema.parse({ organizationId: "northwind-labs", branchId: "kandy-office" }))
      .toEqual({ organizationId: "northwind-labs", branchId: "kandy-office" });
    expect(createDepartmentSchema.parse({
      organizationId: "northwind-labs",
      departmentId: "customer-success",
      name: "Customer Success",
    })).toEqual({
      organizationId: "northwind-labs",
      departmentId: "customer-success",
      name: "Customer Success",
    });
  });

  it("rejects unsafe department identifiers", () => {
    expect(createDepartmentSchema.safeParse({
      organizationId: "northwind-labs",
      departmentId: "../finance",
      name: "Finance",
    }).success).toBe(false);
  });
});

describe("employee and fingerprint enrollment input", () => {
  it("accepts Hikvision-compatible employee data and fingerprint slots", () => {
    expect(createEmployeeSchema.parse({
      organizationId: "northwind-labs",
      employeeCode: "EMP-001",
      name: "Kasun Perera",
      branchId: "colombo",
      departmentId: null,
      deviceId: "office-main-01",
    })).toMatchObject({ employeeCode: "EMP-001", deviceId: "office-main-01" });
    expect(requestFingerprintEnrollmentSchema.parse({
      organizationId: "northwind-labs",
      employeeId: "employee-1",
      deviceId: "office-main-01",
      fingerPrintId: 10,
    }).fingerPrintId).toBe(10);
  });

  it("rejects terminal-incompatible employee codes and fingerprint slots", () => {
    expect(createEmployeeSchema.safeParse({
      organizationId: "northwind-labs",
      employeeCode: "employee code with spaces",
      name: "Kasun Perera",
      branchId: "colombo",
    }).success).toBe(false);
    expect(requestFingerprintEnrollmentSchema.safeParse({
      organizationId: "northwind-labs",
      employeeId: "employee-1",
      deviceId: "office-main-01",
      fingerPrintId: 11,
    }).success).toBe(false);
  });

  it("accepts audited department reassignments and rejects incomplete reasons", () => {
    expect(updateEmployeeDepartmentSchema.parse({
      organizationId: "northwind-labs",
      employeeId: "employee-1",
      departmentId: "operations",
      reason: "Transferred to the operations team",
    })).toMatchObject({ departmentId: "operations" });
    expect(updateEmployeeDepartmentSchema.safeParse({
      organizationId: "northwind-labs",
      employeeId: "employee-1",
      departmentId: null,
      reason: "",
    }).success).toBe(false);
  });
});
