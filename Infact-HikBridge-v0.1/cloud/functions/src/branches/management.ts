import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

import { requireAuthentication, requireOrganizationRole, type AuthContext } from "../authz.js";
import { firestore } from "../firebase.js";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);

export const createBranchSchema = z.object({
  organizationId: idSchema,
  branchId: idSchema,
  name: z.string().trim().min(2).max(100),
}).strict();

export const deleteBranchSchema = z.object({
  organizationId: idSchema,
  branchId: idSchema,
}).strict();

export type CreateBranchInput = z.infer<typeof createBranchSchema>;

export interface CreateBranchResult {
  id: string;
  name: string;
  timezone: string;
  status: "active";
}

export async function createBranchInFirestore(
  db: Firestore,
  auth: AuthContext,
  raw: unknown,
): Promise<CreateBranchResult> {
  const parsed = createBranchSchema.safeParse(raw);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Branch fields are invalid");
  const input = parsed.data;

  await requireOrganizationRole(db, auth, input.organizationId, ["organizationOwner", "hrAdmin"]);

  const organization = db.doc(`organizations/${input.organizationId}`);
  const branch = organization.collection("branches").doc(input.branchId);
  const audit = organization.collection("branchCreationAudits").doc();
  const now = Timestamp.now();
  let timezone = "";

  await db.runTransaction(async (transaction) => {
    const [organizationSnapshot, branchSnapshot] = await Promise.all([
      transaction.get(organization),
      transaction.get(branch),
    ]);
    if (!organizationSnapshot.exists) throw new HttpsError("not-found", "Organization does not exist");
    if (branchSnapshot.exists) throw new HttpsError("already-exists", "That branch identifier is already in use");

    const organizationTimezone = organizationSnapshot.get("timezone");
    if (typeof organizationTimezone !== "string" || organizationTimezone.length === 0) {
      throw new HttpsError("failed-precondition", "Organization timezone is not configured");
    }
    timezone = organizationTimezone;

    transaction.create(branch, {
      name: input.name,
      timezone,
      status: "active",
      createdAt: now,
      createdBy: auth.uid,
      updatedAt: now,
      updatedBy: auth.uid,
    });
    transaction.create(audit, {
      action: "branch_created",
      branchId: input.branchId,
      branchName: input.name,
      actorId: auth.uid,
      createdAt: now,
    });
  });

  return { id: input.branchId, name: input.name, timezone, status: "active" };
}

export async function deleteBranchInFirestore(
  db: Firestore,
  auth: AuthContext,
  raw: unknown,
): Promise<{ id: string; status: "inactive" }> {
  const parsed = deleteBranchSchema.safeParse(raw);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Branch fields are invalid");
  const input = parsed.data;

  await requireOrganizationRole(db, auth, input.organizationId, ["organizationOwner", "hrAdmin"]);

  const organization = db.doc(`organizations/${input.organizationId}`);
  const branch = organization.collection("branches").doc(input.branchId);
  const employees = organization.collection("employees").where("branchId", "==", input.branchId).limit(1);
  const devices = organization.collection("devices").where("branchId", "==", input.branchId).limit(1);
  const members = organization.collection("members").where("branchIds", "array-contains", input.branchId).limit(1);
  const audit = organization.collection("branchDeletionAudits").doc();
  const now = Timestamp.now();

  await db.runTransaction(async (transaction) => {
    const [organizationSnapshot, branchSnapshot, employeeSnapshots, deviceSnapshots, memberSnapshots] = await Promise.all([
      transaction.get(organization),
      transaction.get(branch),
      transaction.get(employees),
      transaction.get(devices),
      transaction.get(members),
    ]);
    if (!organizationSnapshot.exists) throw new HttpsError("not-found", "Organization does not exist");
    if (!branchSnapshot.exists || branchSnapshot.get("status") === "inactive") {
      throw new HttpsError("not-found", "Active branch does not exist");
    }
    if (organizationSnapshot.get("primaryBranchId") === input.branchId) {
      throw new HttpsError("failed-precondition", "The primary branch cannot be deleted");
    }
    if (!employeeSnapshots.empty) {
      throw new HttpsError("failed-precondition", "Move employees to another branch before deleting this branch");
    }
    if (!deviceSnapshots.empty) {
      throw new HttpsError("failed-precondition", "Move or remove devices before deleting this branch");
    }
    if (!memberSnapshots.empty) {
      throw new HttpsError("failed-precondition", "Remove this branch from member access before deleting it");
    }

    transaction.update(branch, {
      status: "inactive",
      deletedAt: now,
      deletedBy: auth.uid,
      updatedAt: now,
      updatedBy: auth.uid,
    });
    transaction.create(audit, {
      action: "branch_deleted",
      branchId: input.branchId,
      branchName: branchSnapshot.get("name"),
      actorId: auth.uid,
      createdAt: now,
    });
  });

  return { id: input.branchId, status: "inactive" };
}

export const createBranch = onCall({ region: "asia-south1" }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const result = await createBranchInFirestore(firestore, auth, request.data);
  logger.info("branch_created", {
    organizationId: request.data?.organizationId,
    branchId: result.id,
    uid: auth.uid,
  });
  return result;
});

export const deleteBranch = onCall({ region: "asia-south1" }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const result = await deleteBranchInFirestore(firestore, auth, request.data);
  logger.info("branch_deleted", {
    organizationId: request.data?.organizationId,
    branchId: result.id,
    uid: auth.uid,
  });
  return result;
});
