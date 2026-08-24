import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { HttpsError } from "firebase-functions/v2/https";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createBranchInFirestore, deleteBranchInFirestore } from "../src/branches/management.js";
import { createDepartmentInFirestore } from "../src/departments/management.js";
import {
  createEmployeeInFirestore,
  queueFingerprintEnrollment,
  updateEmployeeDepartmentInFirestore,
} from "../src/employees/management.js";
import { bootstrapOrganizationInFirestore, type BootstrapOrganizationInput } from "../src/onboarding/bootstrap.js";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const run = emulatorHost === undefined ? describe.skip : describe;
const projectId = "demo-hikbridge";
const app = initializeApp({ projectId }, `onboarding-${projectId}`);
const db = getFirestore(app);
const input: BootstrapOrganizationInput = {
  organizationId: "org-onboarding",
  organizationName: "Onboarding Test",
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
};

run("organization onboarding", () => {
  beforeEach(async () => {
    await db.recursiveDelete(db.collection("organizations").doc(input.organizationId));
    await db.doc("users/owner-1").delete();
    await db.doc("users/owner-2").delete();
    await db.doc("bridgeDeviceRegistry/office-main-01").delete();
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  it("creates the profile, owner membership, branch, and default shift atomically", async () => {
    const result = await bootstrapOrganizationInFirestore(db, {
      uid: "owner-1",
      token: { email: "owner@example.com", name: "Owner One" },
    }, input);
    const [user, organization, member, branch, shift] = await Promise.all([
      db.doc("users/owner-1").get(),
      db.doc(`organizations/${input.organizationId}`).get(),
      db.doc(`organizations/${input.organizationId}/members/owner-1`).get(),
      db.doc(`organizations/${input.organizationId}/branches/colombo`).get(),
      db.doc(`organizations/${input.organizationId}/shifts/NORMAL`).get(),
    ]);

    expect(result.role).toBe("organizationOwner");
    expect(user.get("defaultOrganizationId")).toBe(input.organizationId);
    expect(organization.get("timezone")).toBe("Asia/Colombo");
    expect(member.data()).toMatchObject({ role: "organizationOwner", active: true, branchIds: ["colombo"] });
    expect(branch.get("status")).toBe("active");
    expect(shift.data()).toMatchObject({ startTime: "08:30", endTime: "17:30", active: true });
  });

  it("refuses a second organization for the same user", async () => {
    const auth = { uid: "owner-1", token: { email: "owner@example.com" } };
    await bootstrapOrganizationInFirestore(db, auth, input);
    await expect(bootstrapOrganizationInFirestore(db, auth, { ...input, organizationId: "another-org" }))
      .rejects.toMatchObject({ code: "failed-precondition" } satisfies Partial<HttpsError>);
  });

  it("refuses to claim an existing organization identifier", async () => {
    await bootstrapOrganizationInFirestore(db, { uid: "owner-1", token: {} }, input);
    await expect(bootstrapOrganizationInFirestore(db, { uid: "owner-2", token: {} }, input))
      .rejects.toMatchObject({ code: "already-exists" } satisfies Partial<HttpsError>);
    expect((await db.doc("users/owner-2").get()).exists).toBe(false);
  });

  it("lets an owner create an additional audited branch", async () => {
    const auth = { uid: "owner-1", token: { email: "owner@example.com" } };
    await bootstrapOrganizationInFirestore(db, auth, input);

    const result = await createBranchInFirestore(db, auth, {
      organizationId: input.organizationId,
      branchId: "kandy",
      name: "Kandy Office",
    });
    const branch = await db.doc(`organizations/${input.organizationId}/branches/kandy`).get();
    const audits = await db.collection(`organizations/${input.organizationId}/branchCreationAudits`).get();

    expect(result).toEqual({ id: "kandy", name: "Kandy Office", timezone: "Asia/Colombo", status: "active" });
    expect(branch.data()).toMatchObject({ name: "Kandy Office", timezone: "Asia/Colombo", status: "active" });
    expect(audits.docs).toHaveLength(1);
    expect(audits.docs[0]?.data()).toMatchObject({ action: "branch_created", branchId: "kandy", actorId: "owner-1" });
  });

  it("refuses duplicate branches", async () => {
    const auth = { uid: "owner-1", token: {} };
    await bootstrapOrganizationInFirestore(db, auth, input);
    await expect(createBranchInFirestore(db, auth, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      name: "Duplicate Colombo",
    })).rejects.toMatchObject({ code: "already-exists" } satisfies Partial<HttpsError>);
  });

  it("creates an audited department and refuses duplicate identifiers", async () => {
    const auth = { uid: "owner-1", token: { email: "owner@example.com" } };
    await bootstrapOrganizationInFirestore(db, auth, input);

    const result = await createDepartmentInFirestore(db, auth, {
      organizationId: input.organizationId,
      departmentId: "operations",
      name: "Operations",
    });
    const department = await db.doc(`organizations/${input.organizationId}/departments/operations`).get();
    const audits = await db.collection(`organizations/${input.organizationId}/departmentCreationAudits`).get();

    expect(result).toEqual({ id: "operations", name: "Operations" });
    expect(department.data()).toMatchObject({ name: "Operations", createdBy: "owner-1" });
    expect(audits.docs).toHaveLength(1);
    await expect(createDepartmentInFirestore(db, auth, {
      organizationId: input.organizationId,
      departmentId: "operations",
      name: "Duplicate Operations",
    })).rejects.toMatchObject({ code: "already-exists" } satisfies Partial<HttpsError>);
  });

  it("archives an unused non-primary branch and keeps an audit trail", async () => {
    const auth = { uid: "owner-1", token: { email: "owner@example.com" } };
    await bootstrapOrganizationInFirestore(db, auth, input);
    await createBranchInFirestore(db, auth, {
      organizationId: input.organizationId,
      branchId: "galle",
      name: "Galle Office",
    });

    await expect(deleteBranchInFirestore(db, auth, {
      organizationId: input.organizationId,
      branchId: input.branchId,
    })).rejects.toMatchObject({ code: "failed-precondition" } satisfies Partial<HttpsError>);

    const result = await deleteBranchInFirestore(db, auth, {
      organizationId: input.organizationId,
      branchId: "galle",
    });
    const branch = await db.doc(`organizations/${input.organizationId}/branches/galle`).get();
    const audits = await db.collection(`organizations/${input.organizationId}/branchDeletionAudits`).get();

    expect(result).toEqual({ id: "galle", status: "inactive" });
    expect(branch.data()).toMatchObject({ status: "inactive", deletedBy: "owner-1" });
    expect(audits.docs).toHaveLength(1);
  });

  it("refuses to archive a branch that still has an employee", async () => {
    const auth = { uid: "owner-1", token: { email: "owner@example.com" } };
    await bootstrapOrganizationInFirestore(db, auth, input);
    await createBranchInFirestore(db, auth, {
      organizationId: input.organizationId,
      branchId: "jaffna",
      name: "Jaffna Office",
    });
    await createEmployeeInFirestore(db, auth, {
      organizationId: input.organizationId,
      employeeCode: "EMP-JAF",
      name: "Jaffna Employee",
      branchId: "jaffna",
    });

    await expect(deleteBranchInFirestore(db, auth, {
      organizationId: input.organizationId,
      branchId: "jaffna",
    })).rejects.toMatchObject({ code: "failed-precondition" } satisfies Partial<HttpsError>);
  });

  it("creates an employee and queues one template-free enrollment command per terminal", async () => {
    const auth = { uid: "owner-1", token: { email: "owner@example.com" } };
    await bootstrapOrganizationInFirestore(db, auth, input);
    await db.doc("bridgeDeviceRegistry/office-main-01").set({
      organizationId: input.organizationId,
      branchId: input.branchId,
      state: "active",
      enabled: true,
      deviceDocumentPath: `organizations/${input.organizationId}/devices/office-main-01`,
    });

    const created = await createEmployeeInFirestore(db, auth, {
      organizationId: input.organizationId,
      employeeCode: "EMP-17",
      name: "Kasun Perera",
      branchId: input.branchId,
      deviceId: "office-main-01",
    });
    expect(created.commandId).not.toBeNull();

    const enrollment = await queueFingerprintEnrollment(db, auth, {
      organizationId: input.organizationId,
      employeeId: created.employeeId,
      deviceId: "office-main-01",
      fingerPrintId: 2,
    });
    const command = await db.doc(
      `organizations/${input.organizationId}/devices/office-main-01/commands/${enrollment.commandId}`,
    ).get();
    expect(command.data()).toMatchObject({
      type: "enroll_fingerprint",
      employeeNo: "EMP-17",
      fingerPrintId: 2,
      state: "queued",
    });
    expect(command.get("fingerData")).toBeUndefined();
    expect((await db.doc(
      `organizations/${input.organizationId}/devices/office-main-01/commandLocks/fingerprint`,
    ).get()).get("commandId")).toBe(enrollment.commandId);

    await expect(queueFingerprintEnrollment(db, auth, {
      organizationId: input.organizationId,
      employeeId: created.employeeId,
      deviceId: "office-main-01",
      fingerPrintId: 3,
    })).rejects.toMatchObject({ code: "failed-precondition" } satisfies Partial<HttpsError>);
  });

  it("changes an employee department without altering their device identity", async () => {
    const auth = { uid: "owner-1", token: { email: "owner@example.com" } };
    await bootstrapOrganizationInFirestore(db, auth, input);
    await createDepartmentInFirestore(db, auth, {
      organizationId: input.organizationId,
      departmentId: "operations",
      name: "Operations",
    });
    const created = await createEmployeeInFirestore(db, auth, {
      organizationId: input.organizationId,
      employeeCode: "EMP-DEPT",
      name: "Department Employee",
      branchId: input.branchId,
    });

    const result = await updateEmployeeDepartmentInFirestore(db, auth, {
      organizationId: input.organizationId,
      employeeId: created.employeeId,
      departmentId: "operations",
      reason: "Transferred to operations",
    });
    const employee = await db.doc(`organizations/${input.organizationId}/employees/${created.employeeId}`).get();
    const audits = await db.collection(`organizations/${input.organizationId}/employeeDepartmentChangeAudits`).get();

    expect(result).toEqual({ employeeId: created.employeeId, departmentId: "operations" });
    expect(employee.data()).toMatchObject({ departmentId: "operations", updatedBy: "owner-1" });
    expect(audits.docs).toHaveLength(1);
    expect(audits.docs[0]?.data()).toMatchObject({
      action: "employee_department_changed",
      employeeId: created.employeeId,
      fromDepartmentId: null,
      toDepartmentId: "operations",
      actorId: "owner-1",
    });
    await expect(updateEmployeeDepartmentInFirestore(db, auth, {
      organizationId: input.organizationId,
      employeeId: created.employeeId,
      departmentId: "missing-department",
      reason: "Invalid transfer request",
    })).rejects.toMatchObject({ code: "not-found" } satisfies Partial<HttpsError>);
  });
});
