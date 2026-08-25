import { Timestamp, type Firestore, type WriteBatch } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

import { requireAuthentication, requireOrganizationRole, type AuthContext } from "../authz.js";
import { firestore } from "../firebase.js";
import { identityKey } from "../ingest/firestore-repository.js";

const deviceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const mergeDeviceEnrollmentDataSchema = z.object({
  sourceDeviceId: deviceId,
  targetDeviceId: deviceId,
  confirmedSamePhysicalDevice: z.literal(true),
}).strict().refine((input) => input.sourceDeviceId !== input.targetDeviceId, {
  message: "Source and target devices must be different",
});

export interface MergeDeviceEnrollmentDataResult {
  sourceDeviceId: string;
  targetDeviceId: string;
  organizationId: string;
  mappedIdentities: number;
  enrollmentRecords: number;
  resolvedUnmappedIdentities: number;
  serialVerified: boolean;
}

interface EmployeeBinding {
  employeeNo: string;
  employeeId: string;
  enrollment?: Record<string, unknown>;
}

function stringField(data: Record<string, unknown>, field: string): string | null {
  const value = data[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function addBinding(bindings: Map<string, EmployeeBinding>, binding: EmployeeBinding): void {
  const existing = bindings.get(binding.employeeNo);
  if (existing !== undefined && existing.employeeId !== binding.employeeId) {
    throw new HttpsError(
      "failed-precondition",
      `Employee number ${binding.employeeNo} is linked to different employees on the source device`,
    );
  }
  const enrollment = binding.enrollment ?? existing?.enrollment;
  bindings.set(binding.employeeNo, {
    employeeNo: binding.employeeNo,
    employeeId: binding.employeeId,
    ...(enrollment === undefined ? {} : { enrollment }),
  });
}

async function commitWrites(db: Firestore, writes: Array<(batch: WriteBatch) => void>): Promise<void> {
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = db.batch();
    for (const write of writes.slice(offset, offset + 400)) write(batch);
    await batch.commit();
  }
}

export async function mergeDeviceEnrollmentDataInFirestore(
  db: Firestore,
  auth: AuthContext,
  raw: unknown,
): Promise<MergeDeviceEnrollmentDataResult> {
  const parsed = mergeDeviceEnrollmentDataSchema.safeParse(raw);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Device merge fields are invalid");
  const input = parsed.data;
  const sourceRegistry = db.collection("bridgeDeviceRegistry").doc(input.sourceDeviceId);
  const targetRegistry = db.collection("bridgeDeviceRegistry").doc(input.targetDeviceId);
  const [sourceRegistrySnapshot, targetRegistrySnapshot] = await db.getAll(sourceRegistry, targetRegistry);
  if (sourceRegistrySnapshot === undefined || targetRegistrySnapshot === undefined ||
      !sourceRegistrySnapshot.exists || !targetRegistrySnapshot.exists) {
    throw new HttpsError("not-found", "Both device registrations must exist");
  }

  const sourceOrganizationId = sourceRegistrySnapshot.get("organizationId");
  const targetOrganizationId = targetRegistrySnapshot.get("organizationId");
  if (typeof sourceOrganizationId !== "string" || sourceOrganizationId.length === 0 ||
      sourceOrganizationId !== targetOrganizationId) {
    throw new HttpsError("failed-precondition", "Both devices must belong to the same organization");
  }
  const organizationId = sourceOrganizationId;
  await requireOrganizationRole(db, auth, organizationId, ["organizationOwner", "hrAdmin"]);

  const sourcePath = `organizations/${organizationId}/devices/${input.sourceDeviceId}`;
  const targetPath = `organizations/${organizationId}/devices/${input.targetDeviceId}`;
  if (sourceRegistrySnapshot.get("deviceDocumentPath") !== sourcePath ||
      targetRegistrySnapshot.get("deviceDocumentPath") !== targetPath ||
      sourceRegistrySnapshot.get("state") !== "active" ||
      targetRegistrySnapshot.get("state") !== "active") {
    throw new HttpsError("failed-precondition", "Both device registrations must be active and complete");
  }
  const sourceBranchId = sourceRegistrySnapshot.get("branchId");
  const targetBranchId = targetRegistrySnapshot.get("branchId");
  if (typeof sourceBranchId !== "string" || sourceBranchId !== targetBranchId) {
    throw new HttpsError("failed-precondition", "Both devices must belong to the same branch");
  }

  const organization = db.collection("organizations").doc(organizationId);
  const sourceDevice = db.doc(sourcePath);
  const targetDevice = db.doc(targetPath);
  const [sourceDeviceSnapshot, targetDeviceSnapshot] = await db.getAll(sourceDevice, targetDevice);
  if (sourceDeviceSnapshot === undefined || targetDeviceSnapshot === undefined ||
      !sourceDeviceSnapshot.exists || !targetDeviceSnapshot.exists) {
    throw new HttpsError("not-found", "Both organization device records must exist");
  }
  const sourceSerial = sourceDeviceSnapshot.get("deviceSerial");
  const targetSerial = targetDeviceSnapshot.get("deviceSerial");
  const sourceHasSerial = typeof sourceSerial === "string" && sourceSerial.length > 0;
  const targetHasSerial = typeof targetSerial === "string" && targetSerial.length > 0;
  if (sourceHasSerial && targetHasSerial && sourceSerial !== targetSerial) {
    throw new HttpsError("failed-precondition", "The devices report different physical terminal serial numbers");
  }
  const serialVerified = sourceHasSerial && targetHasSerial && sourceSerial === targetSerial;

  const [sourceIdentities, sourceEnrollments, targetIdentities, targetEnrollments, targetUnmapped] = await Promise.all([
    organization.collection("deviceIdentities").where("deviceId", "==", input.sourceDeviceId).get(),
    organization.collection("deviceEnrollments").where("deviceId", "==", input.sourceDeviceId).get(),
    organization.collection("deviceIdentities").where("deviceId", "==", input.targetDeviceId).get(),
    organization.collection("deviceEnrollments").where("deviceId", "==", input.targetDeviceId).get(),
    organization.collection("unmappedIdentities").where("deviceId", "==", input.targetDeviceId).get(),
  ]);

  const bindings = new Map<string, EmployeeBinding>();
  for (const snapshot of sourceIdentities.docs) {
    const data = snapshot.data();
    const employeeNo = stringField(data, "employeeNo");
    const employeeId = stringField(data, "employeeId");
    if (data.active !== false && employeeNo !== null && employeeId !== null) {
      addBinding(bindings, { employeeNo, employeeId });
    }
  }
  for (const snapshot of sourceEnrollments.docs) {
    const data = snapshot.data();
    const employeeNo = stringField(data, "employeeNo");
    const employeeId = stringField(data, "employeeId");
    if (employeeNo !== null && employeeId !== null) {
      addBinding(bindings, { employeeNo, employeeId, enrollment: data });
    }
  }

  const targetOwners = new Map<string, string>();
  for (const snapshot of [...targetIdentities.docs, ...targetEnrollments.docs]) {
    const data = snapshot.data();
    const employeeNo = stringField(data, "employeeNo");
    const employeeId = stringField(data, "employeeId");
    if (employeeNo === null || employeeId === null) continue;
    const current = targetOwners.get(employeeNo);
    if (current !== undefined && current !== employeeId) {
      throw new HttpsError("failed-precondition", `Employee number ${employeeNo} has conflicting data on the target device`);
    }
    targetOwners.set(employeeNo, employeeId);
  }
  for (const binding of bindings.values()) {
    const targetEmployeeId = targetOwners.get(binding.employeeNo);
    if (targetEmployeeId !== undefined && targetEmployeeId !== binding.employeeId) {
      throw new HttpsError(
        "failed-precondition",
        `Employee number ${binding.employeeNo} is linked to a different employee on the target device`,
      );
    }
  }

  const targetEnrollmentByEmployeeNo = new Map(targetEnrollments.docs.flatMap((snapshot) => {
    const employeeNo = stringField(snapshot.data(), "employeeNo");
    return employeeNo === null ? [] : [[employeeNo, snapshot.data()] as const];
  }));
  const targetUnmappedIds = new Set(targetUnmapped.docs.map((snapshot) => snapshot.id));
  const now = Timestamp.now();
  const writes: Array<(batch: WriteBatch) => void> = [];
  let resolvedUnmappedIdentities = 0;

  for (const binding of bindings.values()) {
    const key = identityKey(input.targetDeviceId, binding.employeeNo);
    const identity = organization.collection("deviceIdentities").doc(key);
    writes.push((batch) => batch.set(identity, {
      organizationId,
      branchId: targetBranchId,
      deviceId: input.targetDeviceId,
      employeeNo: binding.employeeNo,
      employeeId: binding.employeeId,
      active: true,
      migratedFromDeviceId: input.sourceDeviceId,
      migratedAt: now,
      migratedBy: auth.uid,
      updatedAt: now,
      updatedBy: auth.uid,
    }, { merge: true }));

    const sourceEnrollment = binding.enrollment;
    const targetEnrollment = targetEnrollmentByEmployeeNo.get(binding.employeeNo);
    const sourceIsEnrolled = sourceEnrollment?.state === "enrolled";
    const targetIsEnrolled = targetEnrollment?.state === "enrolled";
    const enrollmentState = sourceIsEnrolled || targetIsEnrolled ? "enrolled" : "user_synced";
    const fingerPrintId = targetIsEnrolled ? targetEnrollment?.fingerPrintId : sourceEnrollment?.fingerPrintId;
    const quality = targetIsEnrolled ? targetEnrollment?.quality : sourceEnrollment?.quality;
    const enrolledAt = targetIsEnrolled ? targetEnrollment?.enrolledAt : sourceEnrollment?.enrolledAt;
    const enrollment = organization.collection("deviceEnrollments").doc(key);
    writes.push((batch) => batch.set(enrollment, {
      organizationId,
      branchId: targetBranchId,
      deviceId: input.targetDeviceId,
      employeeId: binding.employeeId,
      employeeNo: binding.employeeNo,
      state: enrollmentState,
      commandId: null,
      lastError: null,
      ...(typeof fingerPrintId === "number" ? { fingerPrintId } : {}),
      ...(typeof quality === "number" ? { quality } : {}),
      ...(enrolledAt instanceof Timestamp ? { enrolledAt } : {}),
      migratedFromDeviceId: input.sourceDeviceId,
      migratedAt: now,
      migratedBy: auth.uid,
      updatedAt: now,
    }, { merge: true }));

    if (targetUnmappedIds.has(key)) {
      const unmapped = organization.collection("unmappedIdentities").doc(key);
      writes.push((batch) => batch.set(unmapped, {
        state: "resolved",
        resolvedEmployeeId: binding.employeeId,
        resolvedAt: now,
        resolvedBy: auth.uid,
        updatedAt: now,
      }, { merge: true }));
      resolvedUnmappedIdentities++;
    }
  }

  await commitWrites(db, writes);
  const audit = organization.collection("deviceMergeAudits").doc();
  await audit.create({
    action: "device_enrollment_data_merged",
    sourceDeviceId: input.sourceDeviceId,
    targetDeviceId: input.targetDeviceId,
    branchId: targetBranchId,
    mappedIdentities: bindings.size,
    enrollmentRecords: bindings.size,
    resolvedUnmappedIdentities,
    serialVerified,
    actorId: auth.uid,
    createdAt: Timestamp.now(),
  });

  return {
    sourceDeviceId: input.sourceDeviceId,
    targetDeviceId: input.targetDeviceId,
    organizationId,
    mappedIdentities: bindings.size,
    enrollmentRecords: bindings.size,
    resolvedUnmappedIdentities,
    serialVerified,
  };
}

export const mergeDeviceEnrollmentData = onCall({ region: "asia-south1", timeoutSeconds: 120 }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const result = await mergeDeviceEnrollmentDataInFirestore(firestore, auth, request.data);
  logger.info("device_enrollment_data_merged", {
    organizationId: result.organizationId,
    sourceDeviceId: result.sourceDeviceId,
    targetDeviceId: result.targetDeviceId,
    mappedIdentities: result.mappedIdentities,
    enrollmentRecords: result.enrollmentRecords,
    uid: auth.uid,
  });
  return result;
});
