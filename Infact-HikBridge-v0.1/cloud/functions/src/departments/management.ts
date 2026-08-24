import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

import { requireAuthentication, requireOrganizationRole, type AuthContext } from "../authz.js";
import { firestore } from "../firebase.js";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);

export const createDepartmentSchema = z.object({
  organizationId: idSchema,
  departmentId: idSchema,
  name: z.string().trim().min(2).max(100),
}).strict();

export async function createDepartmentInFirestore(
  db: Firestore,
  auth: AuthContext,
  raw: unknown,
): Promise<{ id: string; name: string }> {
  const parsed = createDepartmentSchema.safeParse(raw);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Department fields are invalid");
  const input = parsed.data;

  await requireOrganizationRole(db, auth, input.organizationId, ["organizationOwner", "hrAdmin"]);

  const organization = db.doc(`organizations/${input.organizationId}`);
  const department = organization.collection("departments").doc(input.departmentId);
  const audit = organization.collection("departmentCreationAudits").doc();
  const now = Timestamp.now();

  await db.runTransaction(async (transaction) => {
    const [organizationSnapshot, departmentSnapshot] = await Promise.all([
      transaction.get(organization),
      transaction.get(department),
    ]);
    if (!organizationSnapshot.exists) throw new HttpsError("not-found", "Organization does not exist");
    if (departmentSnapshot.exists) throw new HttpsError("already-exists", "That department identifier is already in use");

    transaction.create(department, {
      name: input.name,
      createdAt: now,
      createdBy: auth.uid,
      updatedAt: now,
      updatedBy: auth.uid,
    });
    transaction.create(audit, {
      action: "department_created",
      departmentId: input.departmentId,
      departmentName: input.name,
      actorId: auth.uid,
      createdAt: now,
    });
  });

  return { id: input.departmentId, name: input.name };
}

export const createDepartment = onCall({ region: "asia-south1" }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const result = await createDepartmentInFirestore(firestore, auth, request.data);
  logger.info("department_created", {
    organizationId: request.data?.organizationId,
    departmentId: result.id,
    uid: auth.uid,
  });
  return result;
});
