import { randomUUID } from "node:crypto";

import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

import { requireAuthentication, requireOrganizationRole, type AuthContext } from "../authz.js";
import { firestore } from "../firebase.js";
import { identityKey } from "../ingest/firestore-repository.js";

const mappingSchema = z.object({
  organizationId: z.string().min(1).max(128),
  deviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  employeeNo: z.string().min(1).max(128),
  employeeId: z.string().min(1).max(128),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const mapDeviceIdentity = onCall({ region: "asia-south1" }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const parsed = mappingSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Employee mapping fields are invalid");
  }
  const input = parsed.data;
  await requireOrganizationRole(firestore, auth, input.organizationId, ["organizationOwner", "hrAdmin"]);
  const organization = firestore.collection("organizations").doc(input.organizationId);
  const employee = organization.collection("employees").doc(input.employeeId);
  const registry = firestore.collection("bridgeDeviceRegistry").doc(input.deviceId);
  const key = identityKey(input.deviceId, input.employeeNo);
  const mapping = organization.collection("deviceIdentities").doc(key);
  const unmapped = organization.collection("unmappedIdentities").doc(key);
  const audit = organization.collection("identityMappingAudits").doc(randomUUID());
  const job = organization.collection("recalculationJobs").doc(randomUUID());
  const now = Timestamp.now();

  await firestore.runTransaction(async (transaction) => {
    const [employeeSnapshot, registrySnapshot, previousMapping] = await transaction.getAll(employee, registry, mapping);
    if (employeeSnapshot === undefined || registrySnapshot === undefined || previousMapping === undefined) {
      throw new Error("Mapping transaction did not return every requested document");
    }
    if (!employeeSnapshot.exists) {
      throw new HttpsError("not-found", "Cloud employee does not exist");
    }
    if (!registrySnapshot.exists || registrySnapshot.get("organizationId") !== input.organizationId) {
      throw new HttpsError("not-found", "Device does not belong to this organization");
    }
    const previousEmployeeId = previousMapping.exists ? previousMapping.get("employeeId") : null;
    transaction.set(mapping, {
      organizationId: input.organizationId,
      branchId: registrySnapshot.get("branchId"),
      deviceId: input.deviceId,
      employeeNo: input.employeeNo,
      employeeId: input.employeeId,
      active: true,
      updatedAt: now,
      updatedBy: auth.uid,
    }, { merge: true });
    transaction.set(unmapped, {
      state: "resolved",
      resolvedEmployeeId: input.employeeId,
      resolvedAt: now,
      resolvedBy: auth.uid,
    }, { merge: true });
    transaction.create(audit, {
      identityKey: key,
      deviceId: input.deviceId,
      employeeNo: input.employeeNo,
      previousEmployeeId,
      employeeId: input.employeeId,
      reason: input.reason,
      actorId: auth.uid,
      createdAt: now,
    });
    transaction.create(job, {
      type: "identity_mapping",
      identityKey: key,
      deviceId: input.deviceId,
      employeeNo: input.employeeNo,
      employeeId: input.employeeId,
      state: "pending",
      cursor: null,
      createdAt: now,
      createdBy: auth.uid,
    });
  });
  return { identityKey: key, employeeId: input.employeeId, recalculationJobId: job.id };
});
