import { Temporal } from "@js-temporal/polyfill";

import type {
  AttendanceCalculationInput,
  AttendanceCalculationResult,
  AttendanceException,
  AttendancePunch,
  AttendanceStatus,
  ManualAdjustment,
  ShiftDefinition,
} from "./types.js";

const DEFAULT_EARLY_WINDOW_MINUTES = 6 * 60;
const DEFAULT_LATE_WINDOW_MINUTES = 12 * 60;
const DUPLICATE_PUNCH_WINDOW_MILLISECONDS = 60 * 1000;

interface PunchSelection {
  firstIn: Temporal.Instant | null;
  lastOut: Temporal.Instant | null;
  sourceEventIds: string[];
  duplicateCount: number;
  ignoredOutsideWindow: number;
}

interface ShiftWindow {
  start: Temporal.ZonedDateTime;
  end: Temporal.ZonedDateTime;
  earliestPunch: Temporal.Instant;
  latestPunch: Temporal.Instant;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function validShift(shift: ShiftDefinition): void {
  Temporal.PlainTime.from(shift.startTime);
  Temporal.PlainTime.from(shift.endTime);
  nonNegativeInteger(shift.gracePeriodMinutes, "gracePeriodMinutes");
  nonNegativeInteger(shift.breakMinutes, "breakMinutes");
  nonNegativeInteger(shift.earlyLeave.graceMinutes, "earlyLeave.graceMinutes");
  nonNegativeInteger(shift.overtime.startDelayMinutes, "overtime.startDelayMinutes");
  nonNegativeInteger(shift.overtime.minimumMinutes, "overtime.minimumMinutes");
  nonNegativeInteger(shift.overtime.roundingMinutes, "overtime.roundingMinutes");
  if (shift.workingDays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error("workingDays must contain ISO weekdays from 1 through 7");
  }
}

function shiftWindow(date: Temporal.PlainDate, timezone: string, shift: ShiftDefinition): ShiftWindow {
  validShift(shift);
  const startTime = Temporal.PlainTime.from(shift.startTime);
  const endTime = Temporal.PlainTime.from(shift.endTime);
  const start = date.toZonedDateTime({ timeZone: timezone, plainTime: startTime });
  let endDate = date;
  if (Temporal.PlainTime.compare(endTime, startTime) <= 0) {
    endDate = date.add({ days: 1 });
  }
  const end = endDate.toZonedDateTime({ timeZone: timezone, plainTime: endTime });
  const earlyWindow = nonNegativeInteger(
    shift.earlyArrivalWindowMinutes ?? DEFAULT_EARLY_WINDOW_MINUTES,
    "earlyArrivalWindowMinutes",
  );
  const lateWindow = nonNegativeInteger(
    shift.lateDepartureWindowMinutes ?? DEFAULT_LATE_WINDOW_MINUTES,
    "lateDepartureWindowMinutes",
  );
  return {
    start,
    end,
    earliestPunch: start.subtract({ minutes: earlyWindow }).toInstant(),
    latestPunch: end.add({ minutes: lateWindow }).toInstant(),
  };
}

function localDayWindow(date: Temporal.PlainDate, timezone: string): ShiftWindow {
  const start = date.toZonedDateTime({ timeZone: timezone, plainTime: Temporal.PlainTime.from("00:00") });
  const end = date.add({ days: 1 }).toZonedDateTime({
    timeZone: timezone,
    plainTime: Temporal.PlainTime.from("00:00"),
  });
  return { start, end, earliestPunch: start.toInstant(), latestPunch: end.toInstant() };
}

function comparePunches(left: AttendancePunch, right: AttendancePunch): number {
  const time = Temporal.Instant.compare(Temporal.Instant.from(left.occurredAt), Temporal.Instant.from(right.occurredAt));
  return time === 0 ? left.id.localeCompare(right.id) : time;
}

function duplicateGroup(punch: AttendancePunch, mode: ShiftDefinition["punchMode"]): string {
  return mode === "explicit_status" ? punch.direction : "first_last";
}

function selectPunches(punches: AttendancePunch[], mode: ShiftDefinition["punchMode"], window: ShiftWindow): PunchSelection {
  const inWindow: AttendancePunch[] = [];
  let ignoredOutsideWindow = 0;
  for (const punch of punches) {
    const instant = Temporal.Instant.from(punch.occurredAt);
    if (
      Temporal.Instant.compare(instant, window.earliestPunch) < 0 ||
      Temporal.Instant.compare(instant, window.latestPunch) > 0
    ) {
      ignoredOutsideWindow++;
    } else {
      inWindow.push(punch);
    }
  }
  inWindow.sort(comparePunches);
  const unique: AttendancePunch[] = [];
  const duplicateIds: string[] = [];
  const lastSeenByGroup = new Map<string, number>();
  for (const punch of inWindow) {
    const occurredAt = Number(Temporal.Instant.from(punch.occurredAt).epochMilliseconds);
    const group = duplicateGroup(punch, mode);
    const lastSeen = lastSeenByGroup.get(group);
    lastSeenByGroup.set(group, occurredAt);
    if (lastSeen !== undefined && occurredAt - lastSeen <= DUPLICATE_PUNCH_WINDOW_MILLISECONDS) {
      duplicateIds.push(punch.id);
      continue;
    }
    unique.push(punch);
  }

  const explicit = mode === "explicit_status" && unique.some((punch) => punch.direction !== "unknown");
  let firstIn: Temporal.Instant | null = null;
  let lastOut: Temporal.Instant | null = null;
  if (explicit) {
    const checkIns = unique.filter((punch) => punch.direction === "in");
    const checkOuts = unique.filter((punch) => punch.direction === "out");
    if (checkIns[0] !== undefined) firstIn = Temporal.Instant.from(checkIns[0].occurredAt);
    const finalCheckout = checkOuts.at(-1);
    if (finalCheckout !== undefined) lastOut = Temporal.Instant.from(finalCheckout.occurredAt);
  } else if (unique.length === 1 && unique[0] !== undefined) {
    const instant = Temporal.Instant.from(unique[0].occurredAt);
    if (unique[0].direction === "out") lastOut = instant;
    else firstIn = instant;
  } else if (unique.length > 1) {
    firstIn = Temporal.Instant.from(unique[0]?.occurredAt ?? "");
    lastOut = Temporal.Instant.from(unique.at(-1)?.occurredAt ?? "");
  }

  return {
    firstIn,
    lastOut,
    sourceEventIds: unique.map((punch) => punch.id).concat(duplicateIds).sort(),
    duplicateCount: duplicateIds.length,
    ignoredOutsideWindow,
  };
}

function applyAdjustments(
  firstIn: Temporal.Instant | null,
  lastOut: Temporal.Instant | null,
  initialStatus: AttendanceStatus,
  adjustments: ManualAdjustment[],
): { firstIn: Temporal.Instant | null; lastOut: Temporal.Instant | null; status: AttendanceStatus } {
  let adjustedFirstIn = firstIn;
  let adjustedLastOut = lastOut;
  let status = initialStatus;
  for (const adjustment of adjustments) {
    switch (adjustment.kind) {
      case "set_first_in":
        adjustedFirstIn = Temporal.Instant.from(adjustment.occurredAt);
        break;
      case "set_last_out":
        adjustedLastOut = Temporal.Instant.from(adjustment.occurredAt);
        break;
      case "clear_first_in":
        adjustedFirstIn = null;
        break;
      case "clear_last_out":
        adjustedLastOut = null;
        break;
      case "set_status":
        status = adjustment.status;
        break;
    }
  }
  return { firstIn: adjustedFirstIn, lastOut: adjustedLastOut, status };
}

function minutesFloor(start: Temporal.Instant, end: Temporal.Instant): number {
  return Math.max(0, Math.floor(Number(end.epochMilliseconds - start.epochMilliseconds) / 60_000));
}

function minutesCeil(start: Temporal.Instant, end: Temporal.Instant): number {
  return Math.max(0, Math.ceil(Number(end.epochMilliseconds - start.epochMilliseconds) / 60_000));
}

function overtimeMinutes(rawMinutes: number, shift: ShiftDefinition): number {
  if (!shift.overtime.enabled || rawMinutes < shift.overtime.minimumMinutes) return 0;
  const increment = shift.overtime.roundingMinutes;
  if (shift.overtime.roundingMode === "none" || increment <= 1) return rawMinutes;
  const ratio = rawMinutes / increment;
  switch (shift.overtime.roundingMode) {
    case "floor": return Math.floor(ratio) * increment;
    case "nearest": return Math.round(ratio) * increment;
    case "ceil": return Math.ceil(ratio) * increment;
  }
}

function localTime(instant: Temporal.Instant | null, timezone: string): string | null {
  if (instant === null) return null;
  return instant.toZonedDateTimeISO(timezone).toPlainTime().toString({ smallestUnit: "minute" });
}

function deriveBaseStatus(
  hasPunch: boolean,
  isWorkingDay: boolean,
  hasShift: boolean,
  holiday: boolean,
  leave: boolean,
): AttendanceStatus {
  if (hasPunch) return "present";
  if (leave) return "leave";
  if (holiday) return "holiday";
  if (!hasShift) return "no_shift";
  return isWorkingDay ? "absent" : "rest_day";
}

function addException(exceptions: Set<AttendanceException>, condition: boolean, value: AttendanceException): void {
  if (condition) exceptions.add(value);
}

export function calculateAttendance(input: AttendanceCalculationInput): AttendanceCalculationResult {
  const date = Temporal.PlainDate.from(input.date);
  const shift = input.shift;
  const window = shift === null ? localDayWindow(date, input.timezone) : shiftWindow(date, input.timezone, shift);
  const selected = selectPunches(input.punches, shift?.punchMode ?? "first_last", window);
  const isWorkingDay = shift !== null && shift.workingDays.includes(date.dayOfWeek);
  const hasRawPunch = selected.firstIn !== null || selected.lastOut !== null;
  const baseStatus = deriveBaseStatus(
    hasRawPunch,
    isWorkingDay,
    shift !== null,
    input.holiday !== undefined && input.holiday !== null,
    input.leave !== undefined && input.leave !== null,
  );
  const adjustments = [...(input.approvedAdjustments ?? [])].sort((left, right) => {
    const approved = (left.approvedAt ?? "").localeCompare(right.approvedAt ?? "");
    return approved === 0 ? left.id.localeCompare(right.id) : approved;
  });
  const adjusted = applyAdjustments(selected.firstIn, selected.lastOut, baseStatus, adjustments);
  const firstIn = adjusted.firstIn;
  const lastOut = adjusted.lastOut;
  const hasPunch = firstIn !== null || lastOut !== null;
  const status = adjustments.some((adjustment) => adjustment.kind === "set_status") ? adjusted.status : deriveBaseStatus(
    hasPunch,
    isWorkingDay,
    shift !== null,
    input.holiday !== undefined && input.holiday !== null,
    input.leave !== undefined && input.leave !== null,
  );

  let lateMinutes = 0;
  let earlyLeaveMinutes = 0;
  let workedMinutes = 0;
  let overtime = 0;
  if (firstIn !== null && lastOut !== null && Temporal.Instant.compare(lastOut, firstIn) >= 0) {
    workedMinutes = Math.max(0, minutesFloor(firstIn, lastOut) - (shift?.breakMinutes ?? 0));
  }
  if (shift !== null) {
    const scheduledIn = window.start.toInstant();
    const scheduledOut = window.end.toInstant();
    const lateThreshold = window.start.add({ minutes: shift.gracePeriodMinutes }).toInstant();
    if (firstIn !== null && Temporal.Instant.compare(firstIn, lateThreshold) > 0) {
      lateMinutes = shift.lateCalculationMode === "from_shift_start" ?
        minutesCeil(scheduledIn, firstIn) : minutesCeil(lateThreshold, firstIn);
    }
    const earlyThreshold = window.end.subtract({ minutes: shift.earlyLeave.graceMinutes }).toInstant();
    if (lastOut !== null && Temporal.Instant.compare(lastOut, earlyThreshold) < 0) {
      earlyLeaveMinutes = minutesCeil(lastOut, earlyThreshold);
    }
    if (lastOut !== null) {
      const overtimeStart = window.end.add({ minutes: shift.overtime.startDelayMinutes }).toInstant();
      overtime = overtimeMinutes(minutesFloor(overtimeStart, lastOut), shift);
    }
  }

  const exceptions = new Set<AttendanceException>();
  addException(exceptions, selected.duplicateCount > 0, "duplicate_punches_ignored");
  addException(exceptions, selected.ignoredOutsideWindow > 0, "outside_shift_window_ignored");
  addException(exceptions, firstIn === null && lastOut !== null, "missing_check_in");
  addException(exceptions, firstIn !== null && lastOut === null, "missing_check_out");
  addException(
    exceptions,
    firstIn !== null && lastOut !== null && Temporal.Instant.compare(lastOut, firstIn) < 0,
    "invalid_punch_order",
  );
  addException(exceptions, shift !== null && firstIn !== null && Temporal.Instant.compare(firstIn, window.start.toInstant()) < 0, "early_arrival");
  addException(exceptions, lateMinutes > 0, "late_arrival");
  addException(exceptions, earlyLeaveMinutes > 0, "early_leave");
  addException(exceptions, hasPunch && input.holiday !== undefined && input.holiday !== null, "worked_on_holiday");
  addException(exceptions, hasPunch && input.leave !== undefined && input.leave !== null, "worked_on_leave");
  addException(exceptions, hasPunch && shift !== null && !isWorkingDay, "worked_on_rest_day");
  addException(exceptions, hasPunch && shift === null, "worked_without_shift");

  return {
    organizationId: input.organizationId,
    employeeId: input.employeeId,
    date: date.toString(),
    timezone: input.timezone,
    shiftId: shift?.id ?? null,
    shiftName: shift?.name ?? null,
    scheduledIn: shift?.startTime ?? null,
    scheduledOut: shift?.endTime ?? null,
    scheduledInAt: shift === null ? null : window.start.toInstant().toString(),
    scheduledOutAt: shift === null ? null : window.end.toInstant().toString(),
    firstIn: localTime(firstIn, input.timezone),
    lastOut: localTime(lastOut, input.timezone),
    firstInAt: firstIn?.toString() ?? null,
    lastOutAt: lastOut?.toString() ?? null,
    lateMinutes,
    earlyLeaveMinutes,
    workedMinutes,
    overtimeMinutes: overtime,
    status,
    holidayId: input.holiday?.id ?? null,
    leaveId: input.leave?.id ?? null,
    hasManualAdjustment: adjustments.length > 0,
    adjustmentIds: adjustments.map((adjustment) => adjustment.id),
    sourceEventIds: selected.sourceEventIds,
    exceptions: [...exceptions].sort(),
    calculationVersion: "attendance-v2",
  };
}
