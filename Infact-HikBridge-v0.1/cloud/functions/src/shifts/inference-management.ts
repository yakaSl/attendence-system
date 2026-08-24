import { randomUUID } from "node:crypto";

import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

import { recalculateAttendance } from "../attendance/recalculation.js";
import { requireAuthentication, requireOrganizationRole, type AuthContext } from "../authz.js";
import { firestore } from "../firebase.js";

const documentIdSchema = z.string().min(1).max(128).refine((value) => value !== "." && value !== ".." && !value.includes("/"));

export const resolveShiftInferenceSchema = z.object({
  organizationId: z.string().min(1).max(128),
  inferenceId: documentIdSchema,
  decision: z.enum(["confirm", "reject"]),
  shiftId: documentIdSchema.nullable(),
  reason: z.string().trim().min(3).max(500),
}).strict().superRefine((value, context) => {
  if (value.decision === "confirm" && value.shiftId === null) {
    context.addIssue({ code: "custom", message: "shiftId is required when confirming", path: ["shiftId"] });
  }
});

export async function resolveShiftInferenceInFirestore(
  db: Firestore,
  auth: AuthContext,
  raw: unknown,
): Promise<{ inferenceId: string; state: "confirmed" | "rejected" }> {
  const parsed = resolveShiftInferenceSchema.safeParse(raw);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Shift review fields are invalid");
  const input = parsed.data;
  await requireOrganizationRole(db, auth, input.organizationId, ["organizationOwner", "hrAdmin"]);
  const organization = db.collection("organizations").doc(input.organizationId);
  const inference = organization.collection("shiftInferences").doc(input.inferenceId);
  const audit = organization.collection("shiftInferenceAudits").doc(randomUUID());
  const now = Timestamp.now();
  let employeeId = "";
  let date = "";
  const state = input.decision === "confirm" ? "confirmed" : "rejected";

  await db.runTransaction(async (transaction) => {
    const inferenceSnapshot = await transaction.get(inference);
    if (!inferenceSnapshot.exists || inferenceSnapshot.get("state") !== "review_required") {
      throw new HttpsError("failed-precondition", "This shift suggestion is no longer waiting for review");
    }
    const storedEmployeeId = inferenceSnapshot.get("employeeId");
    const storedDate = inferenceSnapshot.get("date");
    if (typeof storedEmployeeId !== "string" || typeof storedDate !== "string") {
      throw new HttpsError("failed-precondition", "Shift suggestion data is incomplete");
    }
    employeeId = storedEmployeeId;
    date = storedDate;
    if (input.decision === "confirm" && input.shiftId !== null) {
      const shift = await transaction.get(organization.collection("shifts").doc(input.shiftId));
      if (!shift.exists || shift.get("active") === false) {
        throw new HttpsError("not-found", "The selected shift is not active");
      }
    }
    transaction.update(inference, {
      state,
      selectedShiftId: input.decision === "confirm" ? input.shiftId : null,
      resolutionReason: input.reason,
      resolvedAt: now,
      resolvedBy: auth.uid,
      updatedAt: now,
    });
    transaction.create(audit, {
      action: input.decision === "confirm" ? "shift_inference_confirmed" : "shift_inference_rejected",
      inferenceId: input.inferenceId,
      employeeId,
      date,
      suggestedShiftId: inferenceSnapshot.get("suggestedShiftId") ?? null,
      selectedShiftId: input.decision === "confirm" ? input.shiftId : null,
      reason: input.reason,
      actorId: auth.uid,
      createdAt: now,
    });
  });

  await recalculateAttendance(db, input.organizationId, employeeId, date);
  return { inferenceId: input.inferenceId, state };
}

export const resolveShiftInference = onCall({ region: "asia-south1" }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const result = await resolveShiftInferenceInFirestore(firestore, auth, request.data);
  logger.info("shift_inference_resolved", {
    organizationId: request.data?.organizationId,
    inferenceId: result.inferenceId,
    state: result.state,
    uid: auth.uid,
  });
  return result;
});
