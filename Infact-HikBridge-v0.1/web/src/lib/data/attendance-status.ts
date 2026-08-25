import type { AttendanceDay, AttendanceDisplayStatus } from "./types";

export function attendanceDisplayStatus(
  day: AttendanceDay,
  nowMilliseconds = Date.now(),
): AttendanceDisplayStatus {
  if (day.exceptions.includes("worked_without_shift")) return "unscheduled_punch";
  if (day.exceptions.includes("missing_check_in")) return "missing_punch";
  if (!day.exceptions.includes("missing_check_out")) return day.status;

  const scheduledOut = day.scheduledOutAt === undefined || day.scheduledOutAt === null ?
    Number.NaN : new Date(day.scheduledOutAt).getTime();
  return Number.isFinite(scheduledOut) && nowMilliseconds < scheduledOut ? "checked_in" : "missing_punch";
}
