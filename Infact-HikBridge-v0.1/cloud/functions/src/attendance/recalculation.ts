import { Temporal } from "@js-temporal/polyfill";
import {
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

import { calculateAttendance } from "./engine.js";
import { inferDailyShift, type ShiftInferenceResult } from "./shift-inference.js";
import type {
  AttendanceCalculationResult,
  AttendancePunch,
  AttendanceStatus,
  ManualAdjustment,
  OvertimeRoundingMode,
  PunchDirection,
  ShiftDefinition,
} from "./types.js";

interface RecalculationContext {
  organization: DocumentReference;
  employee: DocumentSnapshot;
  timezone: string;
  branchId: string | null;
  shift: ShiftDefinition | null;
  shiftSource: "assigned" | "automatic" | "confirmed" | null;
  inferenceLocked: boolean;
}

function requiredString(data: DocumentData, field: string, documentPath: string): string {
  const value = data[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${documentPath}.${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(data: DocumentData, field: string): string | null {
  const value = data[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integer(data: DocumentData, field: string, documentPath: string): number {
  const value = data[field];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${documentPath}.${field} must be a non-negative integer`);
  }
  return value as number;
}

function boolean(data: DocumentData, field: string, documentPath: string): boolean {
  const value = data[field];
  if (typeof value !== "boolean") throw new Error(`${documentPath}.${field} must be a boolean`);
  return value;
}

function parseShift(snapshot: DocumentSnapshot): ShiftDefinition {
  const data = snapshot.data();
  if (!snapshot.exists || data === undefined) throw new Error(`Shift ${snapshot.ref.path} does not exist`);
  const overtime = data.overtime;
  const earlyLeave = data.earlyLeave;
  if (typeof overtime !== "object" || overtime === null || typeof earlyLeave !== "object" || earlyLeave === null) {
    throw new Error(`Shift ${snapshot.ref.path} has incomplete policy data`);
  }
  const lateCalculationMode = data.lateCalculationMode;
  if (lateCalculationMode !== "from_shift_start" && lateCalculationMode !== "after_grace") {
    throw new Error(`Shift ${snapshot.ref.path}.lateCalculationMode is invalid`);
  }
  const punchMode = data.punchMode;
  if (punchMode !== "first_last" && punchMode !== "explicit_status") {
    throw new Error(`Shift ${snapshot.ref.path}.punchMode is invalid`);
  }
  const roundingMode = overtime.roundingMode;
  if (!(["none", "floor", "nearest", "ceil"] as unknown[]).includes(roundingMode)) {
    throw new Error(`Shift ${snapshot.ref.path}.overtime.roundingMode is invalid`);
  }
  if (!Array.isArray(data.workingDays)) throw new Error(`Shift ${snapshot.ref.path}.workingDays must be an array`);
  return {
    id: snapshot.id,
    name: requiredString(data, "name", snapshot.ref.path),
    startTime: requiredString(data, "startTime", snapshot.ref.path),
    endTime: requiredString(data, "endTime", snapshot.ref.path),
    workingDays: data.workingDays.map((value: unknown) => {
      if (!Number.isInteger(value)) throw new Error(`Shift ${snapshot.ref.path}.workingDays is invalid`);
      return value as number;
    }),
    gracePeriodMinutes: integer(data, "gracePeriodMinutes", snapshot.ref.path),
    lateCalculationMode,
    breakMinutes: integer(data, "breakMinutes", snapshot.ref.path),
    punchMode,
    ...(Number.isInteger(data.earlyArrivalWindowMinutes) ?
      { earlyArrivalWindowMinutes: data.earlyArrivalWindowMinutes as number } : {}),
    ...(Number.isInteger(data.lateDepartureWindowMinutes) ?
      { lateDepartureWindowMinutes: data.lateDepartureWindowMinutes as number } : {}),
    earlyLeave: {
      graceMinutes: integer(earlyLeave, "graceMinutes", `${snapshot.ref.path}.earlyLeave`),
    },
    overtime: {
      enabled: boolean(overtime, "enabled", `${snapshot.ref.path}.overtime`),
      startDelayMinutes: integer(overtime, "startDelayMinutes", `${snapshot.ref.path}.overtime`),
      minimumMinutes: integer(overtime, "minimumMinutes", `${snapshot.ref.path}.overtime`),
      roundingMinutes: integer(overtime, "roundingMinutes", `${snapshot.ref.path}.overtime`),
      roundingMode: roundingMode as OvertimeRoundingMode,
    },
  };
}

function direction(status: unknown): PunchDirection {
  if (typeof status !== "string") return "unknown";
  const normalized = status.toLowerCase().replace(/[^a-z]/g, "");
  if (["in", "checkin", "clockin", "entry"].includes(normalized)) return "in";
  if (["out", "checkout", "clockout", "exit"].includes(normalized)) return "out";
  return "unknown";
}

function eventPunch(snapshot: QueryDocumentSnapshot): AttendancePunch | null {
  const eventTime = snapshot.get("eventTime");
  if (!(eventTime instanceof Timestamp)) return null;
  return {
    id: snapshot.id,
    occurredAt: eventTime.toDate().toISOString(),
    direction: direction(snapshot.get("attendanceStatus")),
  };
}

function adjustment(snapshot: QueryDocumentSnapshot): ManualAdjustment | null {
  if (snapshot.get("state") !== "approved") return null;
  const kind = snapshot.get("kind");
  const approvedAtValue = snapshot.get("approvedAt");
  const approvedAt = approvedAtValue instanceof Timestamp ? approvedAtValue.toDate().toISOString() : undefined;
  if (kind === "set_first_in" || kind === "set_last_out") {
    const occurredAt = snapshot.get("occurredAt");
    return occurredAt instanceof Timestamp ? {
      id: snapshot.id,
      kind,
      occurredAt: occurredAt.toDate().toISOString(),
      ...(approvedAt === undefined ? {} : { approvedAt }),
    } : null;
  }
  if (kind === "clear_first_in" || kind === "clear_last_out") {
    return { id: snapshot.id, kind, ...(approvedAt === undefined ? {} : { approvedAt }) };
  }
  if (kind === "set_status") {
    const status = snapshot.get("status");
    const valid: AttendanceStatus[] = ["present", "absent", "leave", "holiday", "rest_day", "no_shift"];
    return valid.includes(status as AttendanceStatus) ? {
      id: snapshot.id,
      kind,
      status: status as AttendanceStatus,
      ...(approvedAt === undefined ? {} : { approvedAt }),
    } : null;
  }
  return null;
}

function dateRange(date: string, timezone: string, shift: ShiftDefinition | null): { start: Date; end: Date } {
  const plainDate = Temporal.PlainDate.from(date);
  if (shift === null) {
    const start = plainDate.toZonedDateTime({ timeZone: timezone, plainTime: "00:00" }).toInstant();
    const end = plainDate.add({ days: 1 }).toZonedDateTime({ timeZone: timezone, plainTime: "00:00" }).toInstant();
    return { start: new Date(Number(start.epochMilliseconds)), end: new Date(Number(end.epochMilliseconds)) };
  }
  const startTime = Temporal.PlainTime.from(shift.startTime);
  const endTime = Temporal.PlainTime.from(shift.endTime);
  const scheduledStart = plainDate.toZonedDateTime({ timeZone: timezone, plainTime: startTime });
  const endDate = Temporal.PlainTime.compare(endTime, startTime) <= 0 ? plainDate.add({ days: 1 }) : plainDate;
  const scheduledEnd = endDate.toZonedDateTime({ timeZone: timezone, plainTime: endTime });
  const start = scheduledStart.subtract({ minutes: shift.earlyArrivalWindowMinutes ?? 360 }).toInstant();
  const end = scheduledEnd.add({ minutes: shift.lateDepartureWindowMinutes ?? 720 }).toInstant();
  return { start: new Date(Number(start.epochMilliseconds)), end: new Date(Number(end.epochMilliseconds)) };
}

async function loadContext(db: Firestore, organizationId: string, employeeId: string, date: string): Promise<RecalculationContext> {
  Temporal.PlainDate.from(date);
  const organization = db.collection("organizations").doc(organizationId);
  const employeeRef = organization.collection("employees").doc(employeeId);
  const [organizationSnapshot, employee] = await Promise.all([organization.get(), employeeRef.get()]);
  if (!organizationSnapshot.exists) throw new Error(`Organization ${organizationId} does not exist`);
  if (!employee.exists) throw new Error(`Employee ${employeeId} does not exist in organization ${organizationId}`);
  const timezone = requiredString(organizationSnapshot.data() ?? {}, "timezone", organization.path);
  Temporal.Now.zonedDateTimeISO(timezone);
  const [assignments, inference] = await Promise.all([
    organization.collection("shiftAssignments")
      .where("employeeId", "==", employeeId)
      .where("effectiveFrom", "<=", date)
      .orderBy("effectiveFrom", "desc")
      .limit(20)
      .get(),
    organization.collection("shiftInferences").doc(`${employeeId}_${date}`).get(),
  ]);
  const activeAssignment = assignments.docs.find((candidate) => {
    const effectiveTo = candidate.get("effectiveTo");
    return effectiveTo === null || effectiveTo === undefined || (typeof effectiveTo === "string" && effectiveTo >= date);
  });
  let shift: ShiftDefinition | null = null;
  let shiftSource: RecalculationContext["shiftSource"] = null;
  let inferenceLocked = false;
  if (activeAssignment !== undefined) {
    const shiftId = requiredString(activeAssignment.data(), "shiftId", activeAssignment.ref.path);
    shift = parseShift(await organization.collection("shifts").doc(shiftId).get());
    shiftSource = "assigned";
  } else if (inference.exists && inference.get("state") === "confirmed") {
    const shiftId = requiredString(inference.data() ?? {}, "selectedShiftId", inference.ref.path);
    shift = parseShift(await organization.collection("shifts").doc(shiftId).get());
    shiftSource = "confirmed";
    inferenceLocked = true;
  } else if (inference.exists && inference.get("state") === "rejected") {
    inferenceLocked = true;
  }
  return {
    organization,
    employee,
    timezone,
    branchId: optionalString(employee.data() ?? {}, "branchId"),
    shift,
    shiftSource,
    inferenceLocked,
  };
}

async function loadPunchesBetween(
  context: RecalculationContext,
  employeeId: string,
  date: string,
  range: { start: Date; end: Date },
): Promise<AttendancePunch[]> {
  const events = context.organization.collection("attendanceEvents");
  const directQuery = events.where("employeeId", "==", employeeId)
    .where("eventTime", ">=", Timestamp.fromDate(range.start))
    .where("eventTime", "<", Timestamp.fromDate(range.end))
    .limit(1001);
  const mappingsQuery = context.organization.collection("deviceIdentities")
    .where("employeeId", "==", employeeId)
    .where("active", "==", true)
    .limit(100);
  const [direct, mappings] = await Promise.all([directQuery.get(), mappingsQuery.get()]);
  const identityQueries = mappings.docs.flatMap((mapping) => {
    const deviceId = mapping.get("deviceId");
    const employeeNo = mapping.get("employeeNo");
    if (typeof deviceId !== "string" || typeof employeeNo !== "string") return [];
    return [events
      .where("deviceId", "==", deviceId)
      .where("employeeNo", "==", employeeNo)
      .where("eventTime", ">=", Timestamp.fromDate(range.start))
      .where("eventTime", "<", Timestamp.fromDate(range.end))
      .limit(1001)
      .get()];
  });
  const identityResults = await Promise.all(identityQueries);
  if ([direct, ...identityResults].some((snapshot) => snapshot.size > 1000)) {
    throw new Error(`Attendance punch safety limit exceeded for ${employeeId} on ${date}`);
  }
  const byId = new Map<string, AttendancePunch>();
  for (const snapshot of [direct, ...identityResults]) {
    for (const event of snapshot.docs) {
      const punch = eventPunch(event);
      if (punch !== null) byId.set(punch.id, punch);
    }
  }
  return [...byId.values()];
}

async function loadPunches(context: RecalculationContext, employeeId: string, date: string): Promise<AttendancePunch[]> {
  return loadPunchesBetween(context, employeeId, date, dateRange(date, context.timezone, context.shift));
}

async function inferShift(
  context: RecalculationContext,
  employeeId: string,
  date: string,
): Promise<ShiftInferenceResult | null> {
  if (context.shift !== null || context.inferenceLocked) return null;
  const plainDate = Temporal.PlainDate.from(date);
  const start = plainDate.toZonedDateTime({ timeZone: context.timezone, plainTime: "00:00" })
    .subtract({ hours: 6 }).toInstant();
  const end = plainDate.add({ days: 1 }).toZonedDateTime({ timeZone: context.timezone, plainTime: "00:00" })
    .add({ hours: 6 }).toInstant();
  const [punches, shiftSnapshots] = await Promise.all([
    loadPunchesBetween(context, employeeId, date, {
      start: new Date(Number(start.epochMilliseconds)),
      end: new Date(Number(end.epochMilliseconds)),
    }),
    context.organization.collection("shifts").where("active", "==", true).limit(200).get(),
  ]);
  const shifts = shiftSnapshots.docs.map(parseShift);
  const inference = inferDailyShift({ date, timezone: context.timezone, shifts, punches });
  const reference = context.organization.collection("shiftInferences").doc(`${employeeId}_${date}`);
  const employee = context.employee.data() ?? {};
  const state = inference.confidence === "high" ? "auto_applied" :
    inference.confidence === "none" ? "no_match" : "review_required";
  await reference.set({
    organizationId: context.organization.id,
    employeeId,
    employeeCode: optionalString(employee, "employeeCode") ?? employeeId,
    employeeName: optionalString(employee, "name") ?? employeeId,
    branchId: context.branchId,
    date,
    state,
    confidence: inference.confidence,
    suggestedShiftId: inference.suggestedShiftId,
    selectedShiftId: state === "auto_applied" ? inference.suggestedShiftId : null,
    explanation: inference.explanation,
    candidates: inference.candidates,
    firstPunchAt: inference.candidates[0]?.punchAt ?? null,
    updatedAt: Timestamp.now(),
  }, { merge: true });
  if (state === "auto_applied" && inference.suggestedShiftId !== null) {
    context.shift = shifts.find((shift) => shift.id === inference.suggestedShiftId) ?? null;
    context.shiftSource = context.shift === null ? null : "automatic";
  }
  return inference;
}

async function loadHoliday(context: RecalculationContext, date: string): Promise<{ id: string; name: string } | null> {
  const [singleDate, ranges] = await Promise.all([
    context.organization.collection("holidays").where("date", "==", date).limit(20).get(),
    context.organization.collection("holidays").where("startDate", "<=", date).orderBy("startDate", "desc").limit(50).get(),
  ]);
  const match = [...singleDate.docs, ...ranges.docs].find((candidate) => {
    const data = candidate.data();
    const branchId = optionalString(data, "branchId");
    const endDate = optionalString(data, "endDate");
    const inRange = endDate === null || endDate >= date;
    return data.nonWorking !== false && inRange && (branchId === null || branchId === context.branchId);
  });
  return match === undefined ? null : { id: match.id, name: optionalString(match.data(), "name") ?? "Holiday" };
}

async function loadLeave(context: RecalculationContext, employeeId: string, date: string): Promise<{ id: string; type: string } | null> {
  const snapshots = await context.organization.collection("leaveRequests")
    .where("employeeId", "==", employeeId)
    .where("status", "==", "approved")
    .where("startDate", "<=", date)
    .orderBy("startDate", "desc")
    .limit(50)
    .get();
  const match = snapshots.docs.find((candidate) => {
    const endDate = candidate.get("endDate");
    return typeof endDate === "string" && endDate >= date;
  });
  return match === undefined ? null : { id: match.id, type: optionalString(match.data(), "leaveType") ?? "leave" };
}

async function loadAdjustments(context: RecalculationContext, employeeId: string, date: string): Promise<ManualAdjustment[]> {
  const snapshots = await context.organization.collection("manualAdjustments")
    .where("employeeId", "==", employeeId)
    .where("date", "==", date)
    .limit(101)
    .get();
  if (snapshots.size > 100) throw new Error(`Manual adjustment safety limit exceeded for ${employeeId} on ${date}`);
  return snapshots.docs.map(adjustment).filter((value): value is ManualAdjustment => value !== null);
}

function firestoreProjection(result: AttendanceCalculationResult): DocumentData {
  return {
    ...result,
    ...(result.scheduledInAt === null ? {} : { scheduledInTimestamp: Timestamp.fromDate(new Date(result.scheduledInAt)) }),
    ...(result.scheduledOutAt === null ? {} : { scheduledOutTimestamp: Timestamp.fromDate(new Date(result.scheduledOutAt)) }),
    ...(result.firstInAt === null ? {} : { firstInTimestamp: Timestamp.fromDate(new Date(result.firstInAt)) }),
    ...(result.lastOutAt === null ? {} : { lastOutTimestamp: Timestamp.fromDate(new Date(result.lastOutAt)) }),
    calculatedAt: Timestamp.now(),
  };
}

export async function recalculateAttendance(
  db: Firestore,
  organizationId: string,
  employeeId: string,
  date: string,
): Promise<AttendanceCalculationResult> {
  const context = await loadContext(db, organizationId, employeeId, date);
  const inference = await inferShift(context, employeeId, date);
  const [punches, holiday, leave, approvedAdjustments] = await Promise.all([
    loadPunches(context, employeeId, date),
    loadHoliday(context, date),
    loadLeave(context, employeeId, date),
    loadAdjustments(context, employeeId, date),
  ]);
  const result = calculateAttendance({
    organizationId,
    employeeId,
    date,
    timezone: context.timezone,
    shift: context.shift,
    punches,
    holiday,
    leave,
    approvedAdjustments,
  });
  await context.organization.collection("attendanceDays").doc(`${employeeId}_${date}`).set({
    ...firestoreProjection(result),
    shiftSource: context.shiftSource,
    shiftInferenceConfidence: inference?.confidence ?? null,
  });
  return result;
}

export function candidateAttendanceDates(eventTime: Date, timezone: string): string[] {
  const localDate = Temporal.Instant.from(eventTime.toISOString()).toZonedDateTimeISO(timezone).toPlainDate();
  return [localDate.subtract({ days: 1 }).toString(), localDate.toString()];
}
