import { createHash, randomUUID } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";
import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

import { requireAuthentication, requireOrganizationRole, type AuthContext } from "../authz.js";
import { firestore } from "../firebase.js";
import { candidateAttendanceDates, recalculateAttendance } from "./recalculation.js";

const recalculationSchema = z.object({
  organizationId: z.string().min(1).max(128),
  employeeId: z.string().min(1).max(128),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

const adjustmentSchema = recalculationSchema.extend({
  requestId: z.uuid(),
  kind: z.enum(["set_first_in", "set_last_out", "clear_first_in", "clear_last_out", "set_status"]),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  status: z.enum(["present", "absent", "leave", "holiday", "rest_day", "no_shift"]).optional(),
  reason: z.string().trim().min(3).max(500),
}).strict().superRefine((value, context) => {
  const needsTime = value.kind === "set_first_in" || value.kind === "set_last_out";
  if (needsTime !== (value.occurredAt !== undefined)) {
    context.addIssue({ code: "custom", message: "occurredAt is required only for set time adjustments", path: ["occurredAt"] });
  }
  if ((value.kind === "set_status") !== (value.status !== undefined)) {
    context.addIssue({ code: "custom", message: "status is required only for set_status", path: ["status"] });
  }
});

export const recalculateAttendanceDay = onCall({ region: "asia-south1" }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const parsed = recalculationSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Attendance recalculation fields are invalid");
  await requireOrganizationRole(firestore, auth, parsed.data.organizationId, ["organizationOwner", "hrAdmin"]);
  return recalculateAttendance(firestore, parsed.data.organizationId, parsed.data.employeeId, parsed.data.date);
});

export const createManualAdjustment = onCall({ region: "asia-south1" }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const parsed = adjustmentSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Manual adjustment fields are invalid");
  const input = parsed.data;
  await requireOrganizationRole(firestore, auth, input.organizationId, ["organizationOwner", "hrAdmin"]);
  const organization = firestore.collection("organizations").doc(input.organizationId);
  const requestHash = createHash("sha256").update(JSON.stringify({
    employeeId: input.employeeId,
    date: input.date,
    kind: input.kind,
    occurredAt: input.occurredAt ?? null,
    status: input.status ?? null,
    reason: input.reason,
  })).digest("hex");
  if (input.occurredAt !== undefined) {
    const organizationSnapshot = await organization.get();
    const timezone = organizationSnapshot.get("timezone");
    if (typeof timezone !== "string") throw new HttpsError("failed-precondition", "Organization timezone is not configured");
    const targetDate = Temporal.PlainDate.from(input.date);
    const adjustmentDate = Temporal.Instant.from(input.occurredAt).toZonedDateTimeISO(timezone).toPlainDate();
    if (
      Temporal.PlainDate.compare(adjustmentDate, targetDate.subtract({ days: 1 })) < 0 ||
      Temporal.PlainDate.compare(adjustmentDate, targetDate.add({ days: 1 })) > 0
    ) {
      throw new HttpsError("invalid-argument", "Adjusted punch time is outside the attendance workday window");
    }
  }
  const employee = organization.collection("employees").doc(input.employeeId);
  const day = organization.collection("attendanceDays").doc(`${input.employeeId}_${input.date}`);
  const adjustment = organization.collection("manualAdjustments").doc(input.requestId);
  const now = Timestamp.now();
  const adjustmentData = {
    organizationId: input.organizationId,
    employeeId: input.employeeId,
    date: input.date,
    kind: input.kind,
    ...(input.occurredAt === undefined ? {} : { occurredAt: Timestamp.fromDate(new Date(input.occurredAt)) }),
    ...(input.status === undefined ? {} : { status: input.status }),
    reason: input.reason,
    state: "approved",
    actorId: auth.uid,
    approvedBy: auth.uid,
    createdAt: now,
    approvedAt: now,
    requestHash,
  };

  await firestore.runTransaction(async (transaction) => {
    const [employeeSnapshot, previousAdjustment, oldDay] = await transaction.getAll(employee, adjustment, day);
    if (employeeSnapshot === undefined || previousAdjustment === undefined || oldDay === undefined) {
      throw new Error("Adjustment transaction did not load all required documents");
    }
    if (!employeeSnapshot.exists) throw new HttpsError("not-found", "Employee does not exist");
    if (previousAdjustment.exists) {
      if (previousAdjustment.get("requestHash") !== requestHash) {
        throw new HttpsError("already-exists", "Adjustment request ID has already been used");
      }
      return;
    }
    transaction.create(adjustment, {
      ...adjustmentData,
      oldCalculatedState: oldDay.exists ? oldDay.data() : null,
    });
  });

  const result = await recalculateAttendance(firestore, input.organizationId, input.employeeId, input.date);
  const audit = organization.collection("adjustmentAudits").doc(input.requestId);
  await firestore.runTransaction(async (transaction) => {
    const [auditSnapshot, adjustmentSnapshot] = await transaction.getAll(audit, adjustment);
    if (auditSnapshot === undefined || adjustmentSnapshot === undefined) {
      throw new Error("Adjustment audit transaction did not load all required documents");
    }
    if (!auditSnapshot.exists) {
      transaction.create(audit, {
        adjustmentId: input.requestId,
        employeeId: input.employeeId,
        date: input.date,
        oldCalculatedState: adjustmentSnapshot.get("oldCalculatedState") ?? null,
        adjustment: adjustmentData,
        newCalculatedState: result,
        reason: input.reason,
        actorId: auth.uid,
        calculationVersion: result.calculationVersion,
        createdAt: Timestamp.now(),
      });
    }
  });
  return { adjustmentId: input.requestId, attendance: result };
});

export const recalculateNewAttendanceEvent = onDocumentCreated({
  document: "organizations/{organizationId}/attendanceEvents/{eventId}",
  region: "asia-south1",
  retry: true,
}, async (event) => {
  const snapshot = event.data;
  if (snapshot === undefined) return;
  const employeeId = snapshot.get("employeeId");
  const eventTime = snapshot.get("eventTime");
  if (typeof employeeId !== "string" || !(eventTime instanceof Timestamp)) return;
  const organizationId = event.params.organizationId;
  const organization = await firestore.collection("organizations").doc(organizationId).get();
  const timezone = organization.get("timezone");
  if (typeof timezone !== "string") {
    logger.error("attendance_recalculation_missing_timezone", { organizationId, eventId: snapshot.id });
    return;
  }
  for (const date of candidateAttendanceDates(eventTime.toDate(), timezone)) {
    try {
      await recalculateAttendance(firestore, organizationId, employeeId, date);
    } catch (error) {
      logger.error("attendance_recalculation_failed", {
        organizationId,
        employeeId,
        date,
        eventId: snapshot.id,
        attemptId: randomUUID(),
        error,
      });
      throw error;
    }
  }
});
