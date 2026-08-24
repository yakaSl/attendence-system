import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, serverTimestamp, setDoc, updateDoc, writeBatch, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";

const projectId = "demo-hikbridge";
let environment: RulesTestEnvironment;

beforeAll(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: await readFile(resolve(process.cwd(), "firestore.rules"), "utf8"),
    },
  });
});

afterEach(async () => {
  await environment.clearFirestore();
});

afterAll(async () => {
  await environment.cleanup();
});

async function seed(): Promise<void> {
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "organizations/org-a"), { name: "A", timezone: "Asia/Colombo" });
    await setDoc(doc(db, "organizations/org-b"), { name: "B", timezone: "Asia/Colombo" });
    await setDoc(doc(db, "organizations/org-a/members/owner-a"), { role: "organizationOwner", active: true });
    await setDoc(doc(db, "organizations/org-a/members/hr-a"), { role: "hrAdmin", active: true });
    await setDoc(doc(db, "organizations/org-a/members/manager-a"), { role: "manager", active: true });
    await setDoc(doc(db, "organizations/org-a/members/viewer-a"), { role: "viewer", active: true });
    await setDoc(doc(db, "organizations/org-b/members/user-b"), { role: "organizationOwner", active: true });
    await setDoc(doc(db, "organizations/org-a/employees/employee-1"), { employeeCode: "EMP0017", name: "Kasun" });
    await setDoc(doc(db, "organizations/org-a/attendanceEvents/event-1"), { source: "hikvision", employeeNo: "17" });
    await setDoc(doc(db, "organizations/org-a/devices/device-1"), { name: "Main Entrance", enabled: true });
    await setDoc(doc(db, "organizations/org-a/devices/device-1/commands/command-1"), { type: "enroll_fingerprint", state: "queued" });
    await setDoc(doc(db, "organizations/org-a/devices/device-1/commandLocks/fingerprint"), { commandId: "command-1" });
    await setDoc(doc(db, "organizations/org-a/deviceEnrollments/enrollment-1"), { employeeId: "employee-1", state: "queued" });
    await setDoc(doc(db, "organizations/org-a/employeeCodeRegistry/code-1"), { employeeId: "employee-1" });
    await setDoc(doc(db, "organizations/org-a/employeeCreationAudits/audit-1"), { employeeId: "employee-1" });
    await setDoc(doc(db, "organizations/org-a/employeeDepartmentChangeAudits/audit-1"), { employeeId: "employee-1" });
    await setDoc(doc(db, "organizations/org-a/departments/operations"), { name: "Operations" });
    await setDoc(doc(db, "organizations/org-a/shiftInferences/employee-1_2026-08-24"), { employeeId: "employee-1", state: "review_required" });
    await setDoc(doc(db, "organizations/org-a/shiftInferenceAudits/audit-1"), { employeeId: "employee-1" });
    await setDoc(doc(db, "organizations/org-a/shifts/NORMAL"), { name: "Normal Shift" });
    await setDoc(doc(db, "bridgeDeviceRegistry/device-1"), { secretVersionNames: ["secret"] });
    await setDoc(doc(db, "_bridgeCredentials/device-1"), { secret: "must-never-be-readable" });
  });
}

function createOrganizationBootstrap(db: Firestore, userId: string, orgId: string, memberRole = "organizationOwner") {
  const branchId = "colombo";
  const shiftId = "NORMAL";
  const batch = writeBatch(db);
  const auditFields = {
    createdAt: serverTimestamp(),
    createdBy: userId,
    updatedAt: serverTimestamp(),
    updatedBy: userId,
  };
  batch.set(doc(db, `organizations/${orgId}`), {
    name: "New Organization",
    timezone: "Asia/Colombo",
    status: "active",
    primaryBranchId: branchId,
    defaultShiftId: shiftId,
    attendancePolicy: { lateMinutesMode: "after_grace", missingPunchPolicy: "flag_exception" },
    onboardingVersion: "onboarding-v1",
    ...auditFields,
  });
  batch.set(doc(db, `organizations/${orgId}/members/${userId}`), {
    role: memberRole,
    active: true,
    branchIds: [branchId],
    ...auditFields,
  });
  batch.set(doc(db, `organizations/${orgId}/branches/${branchId}`), {
    name: "Colombo HQ",
    timezone: "Asia/Colombo",
    status: "active",
    ...auditFields,
  });
  batch.set(doc(db, `organizations/${orgId}/shifts/${shiftId}`), {
    name: "Normal Shift",
    startTime: "08:30",
    endTime: "17:30",
    workingDays: [1, 2, 3, 4, 5],
    gracePeriodMinutes: 10,
    lateCalculationMode: "after_grace",
    breakMinutes: 60,
    punchMode: "first_last",
    earlyLeave: { graceMinutes: 0 },
    overtime: { enabled: false, startDelayMinutes: 0, minimumMinutes: 0, roundingMinutes: 1, roundingMode: "none" },
    active: true,
    ...auditFields,
  });
  batch.set(doc(db, `organizations/${orgId}/organizationCreationAudits/${userId}`), {
    action: "organization_created",
    organizationId: orgId,
    branchId,
    shiftId,
    actorId: userId,
    createdAt: serverTimestamp(),
  });
  batch.set(doc(db, `users/${userId}`), {
    displayName: "New Owner",
    defaultOrganizationId: orgId,
    onboardingCompletedAt: serverTimestamp(),
    onboardingVersion: "onboarding-v1",
    updatedAt: serverTimestamp(),
    updatedBy: userId,
  });
  return batch.commit();
}

describe("Firestore tenant and role isolation", () => {
  it("allows one complete first-login organization bootstrap", async () => {
    const userId = "first-login-user";
    const db = environment.authenticatedContext(userId).firestore();
    await assertSucceeds(createOrganizationBootstrap(db, userId, "new-organization"));
    await assertSucceeds(getDoc(doc(db, "organizations/new-organization")));
    await assertFails(createOrganizationBootstrap(db, userId, "second-organization"));
  });

  it("allows bootstrap when an existing user profile has no organization", async () => {
    const userId = "precreated-profile-user";
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), `users/${userId}`), { displayName: "Precreated User" });
    });
    const db = environment.authenticatedContext(userId).firestore();
    await assertSucceeds(createOrganizationBootstrap(db, userId, "profile-organization"));
  });

  it("rejects partial or privilege-altered organization bootstraps", async () => {
    const userId = "unsafe-bootstrap-user";
    const db = environment.authenticatedContext(userId).firestore();
    await assertFails(setDoc(doc(db, "organizations/partial-organization"), {
      name: "Partial Organization",
      timezone: "Asia/Colombo",
      status: "active",
      createdBy: userId,
    }));
    await assertFails(createOrganizationBootstrap(db, userId, "unsafe-organization", "platformAdmin"));
  });

  it("allows a member to read their organization and denies another tenant", async () => {
    await seed();
    const viewer = environment.authenticatedContext("viewer-a").firestore();
    await assertSucceeds(getDoc(doc(viewer, "organizations/org-a/employees/employee-1")));
    await assertFails(getDoc(doc(viewer, "organizations/org-b")));
  });

  it("requires server callables for employee mutations", async () => {
    await seed();
    const hr = environment.authenticatedContext("hr-a").firestore();
    const viewer = environment.authenticatedContext("viewer-a").firestore();
    const otherTenant = environment.authenticatedContext("user-b").firestore();
    await assertFails(updateDoc(doc(hr, "organizations/org-a/employees/employee-1"), { name: "Kasun Perera" }));
    await assertFails(setDoc(doc(hr, "organizations/org-a/employees/employee-2"), { name: "Nimali" }));
    await assertFails(setDoc(doc(viewer, "organizations/org-a/employees/employee-3"), { name: "Denied" }));
    await assertFails(setDoc(doc(otherTenant, "organizations/org-a/employees/employee-4"), { name: "Denied" }));
  });

  it("allows department reads but requires audited server APIs for writes", async () => {
    await seed();
    const hr = environment.authenticatedContext("hr-a").firestore();
    await assertSucceeds(getDoc(doc(hr, "organizations/org-a/departments/operations")));
    await assertFails(setDoc(doc(hr, "organizations/org-a/departments/finance"), { name: "Finance" }));
    await assertFails(updateDoc(doc(hr, "organizations/org-a/departments/operations"), { name: "New Operations" }));
  });

  it("shows enrollment status only to HR and hides command, lock, and code registry data", async () => {
    await seed();
    const hr = environment.authenticatedContext("hr-a").firestore();
    const manager = environment.authenticatedContext("manager-a").firestore();
    const platform = environment.authenticatedContext("platform", { platformAdmin: true }).firestore();
    await assertSucceeds(getDoc(doc(hr, "organizations/org-a/deviceEnrollments/enrollment-1")));
    await assertSucceeds(getDoc(doc(hr, "organizations/org-a/employeeCreationAudits/audit-1")));
    await assertSucceeds(getDoc(doc(hr, "organizations/org-a/employeeDepartmentChangeAudits/audit-1")));
    await assertFails(getDoc(doc(manager, "organizations/org-a/employeeDepartmentChangeAudits/audit-1")));
    await assertFails(getDoc(doc(manager, "organizations/org-a/deviceEnrollments/enrollment-1")));
    await assertFails(getDoc(doc(hr, "organizations/org-a/devices/device-1/commands/command-1")));
    await assertFails(getDoc(doc(platform, "organizations/org-a/devices/device-1/commandLocks/fingerprint")));
    await assertFails(getDoc(doc(hr, "organizations/org-a/employeeCodeRegistry/code-1")));
    await assertFails(setDoc(doc(hr, "organizations/org-a/deviceEnrollments/direct"), { state: "enrolled" }));
  });

  it("restricts shift suggestions and their audits to HR read-only access", async () => {
    await seed();
    const hr = environment.authenticatedContext("hr-a").firestore();
    const manager = environment.authenticatedContext("manager-a").firestore();
    const inference = doc(hr, "organizations/org-a/shiftInferences/employee-1_2026-08-24");
    await assertSucceeds(getDoc(inference));
    await assertSucceeds(getDoc(doc(hr, "organizations/org-a/shiftInferenceAudits/audit-1")));
    await assertFails(getDoc(doc(manager, "organizations/org-a/shiftInferences/employee-1_2026-08-24")));
    await assertFails(updateDoc(inference, { state: "confirmed" }));
  });

  it("prevents every browser role from creating or mutating raw events", async () => {
    await seed();
    const hr = environment.authenticatedContext("hr-a").firestore();
    const platform = environment.authenticatedContext("platform", { platformAdmin: true }).firestore();
    await assertFails(updateDoc(doc(hr, "organizations/org-a/attendanceEvents/event-1"), { employeeNo: "99" }));
    await assertFails(setDoc(doc(hr, "organizations/org-a/attendanceEvents/event-2"), { source: "manual" }));
    await assertFails(updateDoc(doc(platform, "organizations/org-a/attendanceEvents/event-1"), { employeeNo: "99" }));
  });

  it("allows device status reads but hides all bridge credential registries", async () => {
    await seed();
    const owner = environment.authenticatedContext("owner-a").firestore();
    const platform = environment.authenticatedContext("platform", { platformAdmin: true }).firestore();
    await assertSucceeds(getDoc(doc(owner, "organizations/org-a/devices/device-1")));
    await assertFails(getDoc(doc(owner, "bridgeDeviceRegistry/device-1")));
    await assertFails(getDoc(doc(platform, "_bridgeCredentials/device-1")));
  });

  it("restricts mapping data to HR roles", async () => {
    await seed();
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "organizations/org-a/unmappedIdentities/identity-1"), { employeeNo: "17" });
    });
    const hr = environment.authenticatedContext("hr-a").firestore();
    const manager = environment.authenticatedContext("manager-a").firestore();
    await assertSucceeds(getDoc(doc(hr, "organizations/org-a/unmappedIdentities/identity-1")));
    await assertFails(getDoc(doc(manager, "organizations/org-a/unmappedIdentities/identity-1")));
  });

  it("allows shift reads but requires audited server APIs for writes", async () => {
    await seed();
    const hr = environment.authenticatedContext("hr-a").firestore();
    await assertSucceeds(getDoc(doc(hr, "organizations/org-a/shifts/NORMAL")));
    await assertFails(updateDoc(doc(hr, "organizations/org-a/shifts/NORMAL"), { gracePeriodMinutes: 30 }));
    await assertFails(setDoc(doc(hr, "organizations/org-a/shiftAssignments/direct-write"), { employeeId: "employee-1", shiftId: "NORMAL" }));
  });
});
