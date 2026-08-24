import { createHash, randomUUID } from "node:crypto";

import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

import { requireAuthentication, requireOrganizationRole, type AuthContext } from "../authz.js";
import { assertCreationWithinLimit } from "../billing/entitlements.js";
import { firestore } from "../firebase.js";
import { identityKey } from "../ingest/firestore-repository.js";

const organizationIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const deviceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const employeeCodeSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);
const documentIdSchema = z.string().min(1).max(128).refine((value) => value !== "." && value !== ".." && !value.includes("/"));
const optionalDateSchema = z.iso.date().optional();
const employeeNameSchema = z.string().trim().min(1).max(128)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(value, "utf8") <= 128);

export const createEmployeeSchema = z.object({
  organizationId: organizationIdSchema,
  employeeCode: employeeCodeSchema,
  name: employeeNameSchema,
  branchId: documentIdSchema,
  departmentId: documentIdSchema.nullable().optional(),
  hireDate: optionalDateSchema,
  deviceId: deviceIdSchema.nullable().optional(),
}).strict();

export const updateEmployeeDepartmentSchema = z.object({
  organizationId: organizationIdSchema,
  employeeId: documentIdSchema,
  departmentId: documentIdSchema.nullable(),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const requestFingerprintEnrollmentSchema = z.object({
  organizationId: organizationIdSchema,
  employeeId: documentIdSchema,
  deviceId: deviceIdSchema,
  fingerPrintId: z.number().int().min(1).max(10),
}).strict();

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

function employeeCodeKey(code: string): string {
  return createHash("sha256").update(code.toLocaleLowerCase("en-US"), "utf8").digest("hex");
}

export async function createEmployeeInFirestore(
  db: Firestore,
  auth: AuthContext,
  raw: unknown,
): Promise<{ employeeId: string; commandId: string | null }> {
  const parsed = createEmployeeSchema.safeParse(raw);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Employee fields are invalid");
  const input = parsed.data;
  await requireOrganizationRole(db, auth, input.organizationId, ["organizationOwner", "hrAdmin"]);

  const organization = db.collection("organizations").doc(input.organizationId);
  const employeeId = randomUUID();
  const employee = organization.collection("employees").doc(employeeId);
  const codeRegistry = organization.collection("employeeCodeRegistry").doc(employeeCodeKey(input.employeeCode));
  const branch = organization.collection("branches").doc(input.branchId);
  const department = input.departmentId === undefined || input.departmentId === null ? null :
    organization.collection("departments").doc(input.departmentId);
  const deviceRegistry = input.deviceId === undefined || input.deviceId === null ? null :
    db.collection("bridgeDeviceRegistry").doc(input.deviceId);
  const commandId = deviceRegistry === null ? null : randomUUID();
  const now = Timestamp.now();

  await db.runTransaction(async (transaction) => {
    await assertCreationWithinLimit(
      transaction,
      db,
      input.organizationId,
      "employees",
      organization.collection("employees").where("active", "==", true),
    );
    const references = [codeRegistry, branch, ...(department === null ? [] : [department]), ...(deviceRegistry === null ? [] : [deviceRegistry])];
    const snapshots = await transaction.getAll(...references);
    const codeSnapshot = snapshots[0];
    const branchSnapshot = snapshots[1];
    if (codeSnapshot?.exists) throw new HttpsError("already-exists", "That employee code is already in use");
    if (!branchSnapshot?.exists || branchSnapshot.get("status") === "inactive") {
      throw new HttpsError("not-found", "The selected branch is not active");
    }
    let index = 2;
    if (department !== null) {
      if (!snapshots[index]?.exists) throw new HttpsError("not-found", "The selected department does not exist");
      index++;
    }
    if (deviceRegistry !== null) {
      const deviceSnapshot = snapshots[index];
      if (!deviceSnapshot?.exists || deviceSnapshot.get("organizationId") !== input.organizationId ||
          deviceSnapshot.get("state") !== "active" || deviceSnapshot.get("enabled") !== true) {
        throw new HttpsError("not-found", "The selected HikBridge device is not active in this organization");
      }
      if (deviceSnapshot.get("branchId") !== input.branchId) {
        throw new HttpsError("failed-precondition", "The selected terminal belongs to a different branch");
      }
    }

    transaction.create(employee, {
      organizationId: input.organizationId,
      employeeCode: input.employeeCode,
      name: input.name,
      branchId: input.branchId,
      departmentId: input.departmentId ?? null,
      status: "active",
      active: true,
      ...(input.hireDate === undefined ? {} : { hireDate: input.hireDate }),
      createdAt: now,
      createdBy: auth.uid,
      updatedAt: now,
      updatedBy: auth.uid,
    });
    transaction.create(codeRegistry, {
      organizationId: input.organizationId,
      employeeId,
      employeeCode: input.employeeCode,
      createdAt: now,
    });
    transaction.create(organization.collection("employeeCreationAudits").doc(randomUUID()), {
      action: "employee_created",
      employeeId,
      employeeCode: input.employeeCode,
      branchId: input.branchId,
      departmentId: input.departmentId ?? null,
      actorId: auth.uid,
      createdAt: now,
    });

    if (input.deviceId !== undefined && input.deviceId !== null && commandId !== null) {
      const key = identityKey(input.deviceId, input.employeeCode);
      transaction.set(organization.collection("deviceIdentities").doc(key), {
        organizationId: input.organizationId,
        branchId: input.branchId,
        deviceId: input.deviceId,
        employeeNo: input.employeeCode,
        employeeId,
        active: true,
        updatedAt: now,
        updatedBy: auth.uid,
      }, { merge: true });
      transaction.create(organization.collection("devices").doc(input.deviceId).collection("commands").doc(commandId), {
        organizationId: input.organizationId,
        branchId: input.branchId,
        deviceId: input.deviceId,
        type: "upsert_user",
        state: "queued",
        employeeId,
        employeeNo: input.employeeCode,
        name: input.name,
        attempts: 0,
        createdAt: now,
        createdBy: auth.uid,
        expiresAt: Timestamp.fromMillis(now.toMillis() + 24 * 60 * 60 * 1000),
        updatedAt: now,
      });
      transaction.set(organization.collection("deviceEnrollments").doc(key), {
        organizationId: input.organizationId,
        branchId: input.branchId,
        deviceId: input.deviceId,
        employeeId,
        employeeNo: input.employeeCode,
        state: "user_pending",
        commandId,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      }, { merge: true });
    }
  });
  return { employeeId, commandId };
}

export async function updateEmployeeDepartmentInFirestore(
  db: Firestore,
  auth: AuthContext,
  raw: unknown,
): Promise<{ employeeId: string; departmentId: string | null }> {
  const parsed = updateEmployeeDepartmentSchema.safeParse(raw);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Department assignment fields are invalid");
  const input = parsed.data;
  await requireOrganizationRole(db, auth, input.organizationId, ["organizationOwner", "hrAdmin"]);

  const organization = db.collection("organizations").doc(input.organizationId);
  const employee = organization.collection("employees").doc(input.employeeId);
  const department = input.departmentId === null ? null : organization.collection("departments").doc(input.departmentId);
  const audit = organization.collection("employeeDepartmentChangeAudits").doc(randomUUID());
  const now = Timestamp.now();

  await db.runTransaction(async (transaction) => {
    const snapshots = await transaction.getAll(employee, ...(department === null ? [] : [department]));
    const employeeSnapshot = snapshots[0];
    const departmentSnapshot = department === null ? null : snapshots[1];
    if (employeeSnapshot === undefined || !employeeSnapshot.exists || employeeSnapshot.get("status") === "inactive") {
      throw new HttpsError("not-found", "The selected employee is not active");
    }
    if (department !== null && (departmentSnapshot === null || departmentSnapshot === undefined || !departmentSnapshot.exists)) {
      throw new HttpsError("not-found", "The selected department does not exist");
    }

    const storedDepartmentId = employeeSnapshot.get("departmentId");
    const previousDepartmentId = typeof storedDepartmentId === "string" && storedDepartmentId.length > 0 ? storedDepartmentId : null;
    if (previousDepartmentId === input.departmentId) {
      throw new HttpsError("failed-precondition", "The employee is already assigned to that department");
    }

    transaction.update(employee, {
      departmentId: input.departmentId,
      updatedAt: now,
      updatedBy: auth.uid,
    });
    transaction.create(audit, {
      action: "employee_department_changed",
      employeeId: input.employeeId,
      fromDepartmentId: previousDepartmentId,
      toDepartmentId: input.departmentId,
      reason: input.reason,
      actorId: auth.uid,
      createdAt: now,
    });
  });

  return { employeeId: input.employeeId, departmentId: input.departmentId };
}

export async function queueFingerprintEnrollment(
  db: Firestore,
  auth: AuthContext,
  raw: unknown,
): Promise<{ commandId: string; employeeId: string; deviceId: string }> {
  const parsed = requestFingerprintEnrollmentSchema.safeParse(raw);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Fingerprint enrollment fields are invalid");
  const input = parsed.data;
  await requireOrganizationRole(db, auth, input.organizationId, ["organizationOwner", "hrAdmin"]);

  const organization = db.collection("organizations").doc(input.organizationId);
  const employee = organization.collection("employees").doc(input.employeeId);
  const deviceRegistry = db.collection("bridgeDeviceRegistry").doc(input.deviceId);
  const commandId = randomUUID();
  const device = organization.collection("devices").doc(input.deviceId);
  const command = device.collection("commands").doc(commandId);
  const fingerprintLock = device.collection("commandLocks").doc("fingerprint");
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(now.toMillis() + 5 * 60 * 1000);

  await db.runTransaction(async (transaction) => {
    const [employeeSnapshot, deviceSnapshot, lockSnapshot] = await transaction.getAll(employee, deviceRegistry, fingerprintLock);
    if (employeeSnapshot === undefined || deviceSnapshot === undefined || lockSnapshot === undefined) {
      throw new Error("Enrollment transaction did not return every requested document");
    }
    if (!employeeSnapshot.exists || employeeSnapshot.get("status") === "inactive") {
      throw new HttpsError("not-found", "The selected employee is not active");
    }
    const employeeNo = employeeSnapshot.get("employeeCode");
    const name = employeeSnapshot.get("name");
    const branchId = employeeSnapshot.get("branchId");
    if (typeof employeeNo !== "string" || !employeeCodeSchema.safeParse(employeeNo).success ||
        typeof name !== "string" || typeof branchId !== "string") {
      throw new HttpsError("failed-precondition", "Employee data is not compatible with this Hikvision terminal");
    }
    if (!deviceSnapshot.exists || deviceSnapshot.get("organizationId") !== input.organizationId ||
        deviceSnapshot.get("state") !== "active" || deviceSnapshot.get("enabled") !== true) {
      throw new HttpsError("not-found", "The selected HikBridge device is not active in this organization");
    }
    if (deviceSnapshot.get("branchId") !== branchId) {
      throw new HttpsError("failed-precondition", "The selected terminal belongs to a different branch");
    }
    const lockExpiresAt = lockSnapshot.get("expiresAt");
    if (lockSnapshot.exists && lockExpiresAt instanceof Timestamp && lockExpiresAt.toMillis() > now.toMillis()) {
      throw new HttpsError("failed-precondition", "Another fingerprint enrollment is already active on this terminal");
    }
    const key = identityKey(input.deviceId, employeeNo);
    transaction.set(organization.collection("deviceIdentities").doc(key), {
      organizationId: input.organizationId,
      branchId,
      deviceId: input.deviceId,
      employeeNo,
      employeeId: input.employeeId,
      active: true,
      updatedAt: now,
      updatedBy: auth.uid,
    }, { merge: true });
    transaction.create(command, {
      organizationId: input.organizationId,
      branchId,
      deviceId: input.deviceId,
      type: "enroll_fingerprint",
      state: "queued",
      employeeId: input.employeeId,
      employeeNo,
      name,
      fingerPrintId: input.fingerPrintId,
      attempts: 0,
      createdAt: now,
      createdBy: auth.uid,
      expiresAt,
      updatedAt: now,
    });
    transaction.set(fingerprintLock, {
      organizationId: input.organizationId,
      deviceId: input.deviceId,
      commandId,
      employeeId: input.employeeId,
      expiresAt,
      updatedAt: now,
    });
    transaction.set(organization.collection("deviceEnrollments").doc(key), {
      organizationId: input.organizationId,
      branchId,
      deviceId: input.deviceId,
      employeeId: input.employeeId,
      employeeNo,
      state: "queued",
      commandId,
      fingerPrintId: input.fingerPrintId,
      lastError: null,
      requestedAt: now,
      requestedBy: auth.uid,
      updatedAt: now,
    }, { merge: true });
  });
  return { commandId, employeeId: input.employeeId, deviceId: input.deviceId };
}

export const createEmployee = onCall({ region: "asia-south1" }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const result = await createEmployeeInFirestore(firestore, auth, request.data);
  logger.info("employee_created", { organizationId: request.data?.organizationId, employeeId: result.employeeId, uid: auth.uid });
  return result;
});

export const updateEmployeeDepartment = onCall({ region: "asia-south1" }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const result = await updateEmployeeDepartmentInFirestore(firestore, auth, request.data);
  logger.info("employee_department_changed", {
    organizationId: request.data?.organizationId,
    employeeId: result.employeeId,
    departmentId: result.departmentId,
    uid: auth.uid,
  });
  return result;
});

export const requestFingerprintEnrollment = onCall({ region: "asia-south1" }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const result = await queueFingerprintEnrollment(firestore, auth, request.data);
  logger.info("fingerprint_enrollment_queued", { organizationId: request.data?.organizationId, employeeId: result.employeeId, deviceId: result.deviceId, uid: auth.uid });
  return result;
});
