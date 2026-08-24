export type LateCalculationMode = "from_shift_start" | "after_grace";
export type PunchMode = "first_last" | "explicit_status";
export type OvertimeRoundingMode = "none" | "floor" | "nearest" | "ceil";

export interface ShiftDefinition {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  workingDays: number[];
  gracePeriodMinutes: number;
  lateCalculationMode: LateCalculationMode;
  breakMinutes: number;
  punchMode: PunchMode;
  earlyArrivalWindowMinutes?: number;
  lateDepartureWindowMinutes?: number;
  earlyLeave: {
    graceMinutes: number;
  };
  overtime: {
    enabled: boolean;
    startDelayMinutes: number;
    minimumMinutes: number;
    roundingMinutes: number;
    roundingMode: OvertimeRoundingMode;
  };
}

export type PunchDirection = "in" | "out" | "unknown";

export interface AttendancePunch {
  id: string;
  occurredAt: string;
  direction: PunchDirection;
}

export type AttendanceStatus =
  | "present"
  | "absent"
  | "leave"
  | "holiday"
  | "rest_day"
  | "no_shift";

export type ManualAdjustment =
  | { id: string; kind: "set_first_in" | "set_last_out"; occurredAt: string; approvedAt?: string }
  | { id: string; kind: "clear_first_in" | "clear_last_out"; approvedAt?: string }
  | { id: string; kind: "set_status"; status: AttendanceStatus; approvedAt?: string };

export interface AttendanceCalculationInput {
  organizationId: string;
  employeeId: string;
  date: string;
  timezone: string;
  shift: ShiftDefinition | null;
  punches: AttendancePunch[];
  holiday?: { id: string; name: string } | null;
  leave?: { id: string; type: string } | null;
  approvedAdjustments?: ManualAdjustment[];
}

export type AttendanceException =
  | "duplicate_punches_ignored"
  | "early_arrival"
  | "early_leave"
  | "invalid_punch_order"
  | "late_arrival"
  | "missing_check_in"
  | "missing_check_out"
  | "outside_shift_window_ignored"
  | "worked_on_holiday"
  | "worked_on_leave"
  | "worked_on_rest_day"
  | "worked_without_shift";

export interface AttendanceCalculationResult {
  organizationId: string;
  employeeId: string;
  date: string;
  timezone: string;
  shiftId: string | null;
  shiftName: string | null;
  scheduledIn: string | null;
  scheduledOut: string | null;
  scheduledInAt: string | null;
  scheduledOutAt: string | null;
  firstIn: string | null;
  lastOut: string | null;
  firstInAt: string | null;
  lastOutAt: string | null;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  workedMinutes: number;
  overtimeMinutes: number;
  status: AttendanceStatus;
  holidayId: string | null;
  leaveId: string | null;
  hasManualAdjustment: boolean;
  adjustmentIds: string[];
  sourceEventIds: string[];
  exceptions: AttendanceException[];
  calculationVersion: "attendance-v1";
}
