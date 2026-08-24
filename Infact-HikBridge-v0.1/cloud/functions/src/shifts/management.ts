import { randomUUID } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

import { requireAuthentication, requireOrganizationRole, type AuthContext } from "../authz.js";
import { firestore } from "../firebase.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const saveShiftSchema = z.object({
  organizationId: z.string().min(1).max(128),
  shiftId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  name: z.string().trim().min(2).max(100),
  startTime: timeSchema,
  endTime: timeSchema,
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  gracePeriodMinutes: z.number().int().min(0).max(240),
  lateCalculationMode: z.enum(["from_shift_start", "after_grace"]),
  breakMinutes: z.number().int().min(0).max(480),
  punchMode: z.enum(["first_last", "explicit_status"]),
  earlyLeaveGraceMinutes: z.number().int().min(0).max(240),
  overtimeEnabled: z.boolean(),
  overtimeStartDelayMinutes: z.number().int().min(0).max(720),
  overtimeMinimumMinutes: z.number().int().min(0).max(720),
  overtimeRoundingMinutes: z.number().int().min(1).max(120),
  overtimeRoundingMode: z.enum(["none", "floor", "nearest", "ceil"]),
  active: z.boolean(),
  recalculateFrom: dateSchema,
  reason: z.string().trim().min(3).max(500),
}).strict();

const assignmentSchema = z.object({
  organizationId: z.string().min(1).max(128),
  employeeId: z.string().min(1).max(128),
  shiftId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  effectiveFrom: dateSchema,
  effectiveTo: dateSchema.nullable(),
  reason: z.string().trim().min(3).max(500),
}).strict().superRefine((value, context) => {
  if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom) {
    context.addIssue({ code: "custom", message: "effectiveTo must not precede effectiveFrom", path: ["effectiveTo"] });
  }
});

async function organizationToday(organizationId: string): Promise<string> {
  const organization = await firestore.collection("organizations").doc(organizationId).get();
  const timezone = organization.get("timezone");
  if (typeof timezone !== "string") throw new HttpsError("failed-precondition", "Organization timezone is not configured");
  return Temporal.Now.zonedDateTimeISO(timezone).toPlainDate().toString();
}

export const saveShift = onCall({ region: "asia-south1" }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const parsed = saveShiftSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Shift fields are invalid");
  const input = parsed.data;
  await requireOrganizationRole(firestore, auth, input.organizationId, ["organizationOwner", "hrAdmin"]);
  const organization = firestore.collection("organizations").doc(input.organizationId);
  const shift = organization.collection("shifts").doc(input.shiftId);
  const audit = organization.collection("shiftChangeAudits").doc(randomUUID());
  const job = organization.collection("recalculationJobs").doc(randomUUID());
  const now = Timestamp.now();
  const today = await organizationToday(input.organizationId);
  const shiftData = {
    name: input.name,
    startTime: input.startTime,
    endTime: input.endTime,
    workingDays: [...new Set(input.workingDays)].sort(),
    gracePeriodMinutes: input.gracePeriodMinutes,
    lateCalculationMode: input.lateCalculationMode,
    breakMinutes: input.breakMinutes,
    punchMode: input.punchMode,
    earlyLeave: { graceMinutes: input.earlyLeaveGraceMinutes },
    overtime: {
      enabled: input.overtimeEnabled,
      startDelayMinutes: input.overtimeStartDelayMinutes,
      minimumMinutes: input.overtimeMinimumMinutes,
      roundingMinutes: input.overtimeRoundingMinutes,
      roundingMode: input.overtimeRoundingMode,
    },
    active: input.active,
    updatedAt: now,
    updatedBy: auth.uid,
  };
  await firestore.runTransaction(async (transaction) => {
    const previous = await transaction.get(shift);
    transaction.set(shift, { ...shiftData, ...(previous.exists ? {} : { createdAt: now, createdBy: auth.uid }) }, { merge: true });
    transaction.create(audit, {
      shiftId: input.shiftId,
      previous: previous.exists ? previous.data() : null,
      next: shiftData,
      reason: input.reason,
      actorId: auth.uid,
      createdAt: now,
    });
    transaction.create(job, {
      type: "shift_policy",
      shiftId: input.shiftId,
      fromDate: input.recalculateFrom,
      toDate: today,
      state: "pending",
      cursorAssignmentId: null,
      createdAt: now,
      createdBy: auth.uid,
    });
  });
  return { shiftId: input.shiftId, recalculationJobId: job.id };
});

export const assignEmployeeShift = onCall({ region: "asia-south1" }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const parsed = assignmentSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Shift assignment fields are invalid");
  const input = parsed.data;
  await requireOrganizationRole(firestore, auth, input.organizationId, ["organizationOwner", "hrAdmin"]);
  const organization = firestore.collection("organizations").doc(input.organizationId);
  const employee = organization.collection("employees").doc(input.employeeId);
  const shift = organization.collection("shifts").doc(input.shiftId);
  const assignments = organization.collection("shiftAssignments").where("employeeId", "==", input.employeeId).limit(100);
  const assignment = organization.collection("shiftAssignments").doc(randomUUID());
  const audit = organization.collection("shiftAssignmentAudits").doc(assignment.id);
  const job = organization.collection("recalculationJobs").doc(randomUUID());
  const now = Timestamp.now();
  const today = await organizationToday(input.organizationId);

  await firestore.runTransaction(async (transaction) => {
    const [employeeSnapshot, shiftSnapshot, existing] = await Promise.all([
      transaction.get(employee),
      transaction.get(shift),
      transaction.get(assignments),
    ]);
    if (!employeeSnapshot.exists) throw new HttpsError("not-found", "Employee does not exist");
    if (!shiftSnapshot.exists || shiftSnapshot.get("active") === false) throw new HttpsError("not-found", "Active shift does not exist");
    const overlaps = existing.docs.some((candidate) => {
      const from = candidate.get("effectiveFrom");
      const to = candidate.get("effectiveTo");
      if (typeof from !== "string") return false;
      const existingTo = typeof to === "string" ? to : "9999-12-31";
      const requestedTo = input.effectiveTo ?? "9999-12-31";
      return from <= requestedTo && input.effectiveFrom <= existingTo;
    });
    if (overlaps) throw new HttpsError("already-exists", "Employee already has a shift assignment in this date range");
    const assignmentData = {
      employeeId: input.employeeId,
      shiftId: input.shiftId,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      reason: input.reason,
      createdAt: now,
      createdBy: auth.uid,
    };
    transaction.create(assignment, assignmentData);
    transaction.create(audit, { assignmentId: assignment.id, action: "created", assignment: assignmentData, actorId: auth.uid, reason: input.reason, createdAt: now });
    transaction.create(job, {
      type: "employee_date_range",
      employeeId: input.employeeId,
      startDate: input.effectiveFrom,
      endDate: input.effectiveTo ?? today,
      cursorDate: input.effectiveFrom,
      state: input.effectiveFrom <= (input.effectiveTo ?? today) ? "pending" : "completed",
      createdAt: now,
      createdBy: auth.uid,
    });
  });
  return { assignmentId: assignment.id, recalculationJobId: job.id };
});
