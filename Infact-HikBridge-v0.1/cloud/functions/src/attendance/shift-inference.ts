import { Temporal } from "@js-temporal/polyfill";

import type { AttendancePunch, ShiftDefinition } from "./types.js";

export interface ShiftInferenceCandidate {
  shiftId: string;
  shiftName: string;
  startTime: string;
  punchId: string;
  punchAt: string;
  distanceMinutes: number;
}

export interface ShiftInferenceResult {
  confidence: "high" | "medium" | "low" | "none";
  suggestedShiftId: string | null;
  explanation: string;
  candidates: ShiftInferenceCandidate[];
}

export interface ShiftInferencePolicy {
  earlyWindowMinutes: number;
  lateWindowMinutes: number;
  highConfidenceDistanceMinutes: number;
  highConfidenceMarginMinutes: number;
  mediumConfidenceDistanceMinutes: number;
  mediumConfidenceMarginMinutes: number;
}

export const defaultShiftInferencePolicy: ShiftInferencePolicy = {
  earlyWindowMinutes: 120,
  lateWindowMinutes: 180,
  highConfidenceDistanceMinutes: 60,
  highConfidenceMarginMinutes: 45,
  mediumConfidenceDistanceMinutes: 120,
  mediumConfidenceMarginMinutes: 30,
};

function minutesBetween(left: Temporal.Instant, right: Temporal.Instant): number {
  return Math.round(Math.abs(Number(left.epochMilliseconds - right.epochMilliseconds)) / 60_000);
}

export function inferDailyShift(input: {
  date: string;
  timezone: string;
  shifts: ShiftDefinition[];
  punches: AttendancePunch[];
  policy?: ShiftInferencePolicy;
}): ShiftInferenceResult {
  const date = Temporal.PlainDate.from(input.date);
  const policy = input.policy ?? defaultShiftInferencePolicy;
  const startPunches = input.punches
    .filter((punch) => punch.direction !== "out")
    .map((punch) => ({ punch, instant: Temporal.Instant.from(punch.occurredAt) }))
    .sort((left, right) => Temporal.Instant.compare(left.instant, right.instant));
  const candidates = input.shifts.flatMap((shift): ShiftInferenceCandidate[] => {
    if (!shift.workingDays.includes(date.dayOfWeek)) return [];
    const scheduledStart = date.toZonedDateTime({
      timeZone: input.timezone,
      plainTime: Temporal.PlainTime.from(shift.startTime),
    }).toInstant();
    const windowStart = scheduledStart.subtract({ minutes: policy.earlyWindowMinutes });
    const windowEnd = scheduledStart.add({ minutes: policy.lateWindowMinutes });
    const match = startPunches.find(({ instant }) =>
      Temporal.Instant.compare(instant, windowStart) >= 0 && Temporal.Instant.compare(instant, windowEnd) <= 0,
    );
    return match === undefined ? [] : [{
      shiftId: shift.id,
      shiftName: shift.name,
      startTime: shift.startTime,
      punchId: match.punch.id,
      punchAt: match.punch.occurredAt,
      distanceMinutes: minutesBetween(match.instant, scheduledStart),
    }];
  }).sort((left, right) => left.distanceMinutes - right.distanceMinutes || left.shiftId.localeCompare(right.shiftId));

  const best = candidates[0];
  if (best === undefined) {
    return {
      confidence: "none",
      suggestedShiftId: null,
      explanation: "No punch falls inside an active shift start window.",
      candidates: [],
    };
  }
  const second = candidates[1];
  const margin = second === undefined ? null : second.distanceMinutes - best.distanceMinutes;
  const highConfidence = best.distanceMinutes <= policy.highConfidenceDistanceMinutes &&
    (margin === null || margin >= policy.highConfidenceMarginMinutes);
  const mediumConfidence = best.distanceMinutes <= policy.mediumConfidenceDistanceMinutes &&
    (margin === null || margin >= policy.mediumConfidenceMarginMinutes);
  const confidence = highConfidence ? "high" : mediumConfidence ? "medium" : "low";
  const marginCopy = margin === null ? "no competing shift was in range" : `the next shift was ${margin} minutes less likely`;
  return {
    confidence,
    suggestedShiftId: best.shiftId,
    explanation: `${best.shiftName} starts ${best.distanceMinutes} minutes from the first eligible punch; ${marginCopy}.`,
    candidates,
  };
}
