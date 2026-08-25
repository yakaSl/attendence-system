export type OrganizationRole = "organizationOwner" | "hrAdmin" | "manager" | "viewer" | "platformAdmin";
export type AttendanceStatus = "present" | "absent" | "leave" | "holiday" | "rest_day" | "no_shift";
export type AttendanceDisplayStatus = AttendanceStatus | "checked_in" | "missing_punch" | "unscheduled_punch";

export interface Organization {
  id: string;
  name: string;
  timezone: string;
  primaryBranchId: string | null;
}

export interface Department {
  id: string;
  name: string;
}

export interface Branch {
  id: string;
  name: string;
  timezone: string;
  status: "active" | "inactive";
}

export interface Employee {
  id: string;
  employeeCode: string;
  name: string;
  departmentId: string | null;
  departmentName: string;
  branchId: string | null;
  branchName: string;
  shiftId: string | null;
  shiftName: string;
  todayStatus: AttendanceDisplayStatus | null;
  lastPunch: string | null;
  lateMinutesThisMonth: number;
  overtimeMinutesThisMonth: number;
  active: boolean;
}

export interface AttendanceDay {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  departmentId: string | null;
  departmentName: string;
  branchId: string | null;
  branchName: string;
  shiftId: string | null;
  shiftName: string;
  date: string;
  scheduledIn: string | null;
  scheduledOut: string | null;
  scheduledOutAt?: string | null;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  status: AttendanceStatus;
  exceptions: string[];
  hasManualAdjustment: boolean;
  shiftSource?: "assigned" | "automatic" | "confirmed" | null;
  shiftInferenceConfidence?: "high" | "medium" | "low" | "none" | null;
}

export interface ShiftInferenceCandidate {
  shiftId: string;
  shiftName: string;
  startTime: string;
  punchAt: string;
  distanceMinutes: number;
}

export interface ShiftInference {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  date: string;
  confidence: "medium" | "low";
  suggestedShiftId: string | null;
  firstPunchAt: string | null;
  explanation: string;
  candidates: ShiftInferenceCandidate[];
}

export interface Shift {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  workingDays: number[];
  gracePeriodMinutes: number;
  lateCalculationMode: "from_shift_start" | "after_grace";
  breakMinutes: number;
  punchMode: "first_last" | "explicit_status";
  earlyLeaveGraceMinutes: number;
  overtimeEnabled: boolean;
  overtimeStartDelayMinutes: number;
  overtimeMinimumMinutes: number;
  overtimeRoundingMinutes: number;
  overtimeRoundingMode: "none" | "floor" | "nearest" | "ceil";
  active: boolean;
}

export interface Device {
  id: string;
  branchId: string;
  name: string;
  model: string;
  branchName: string;
  connectionStatus: "online" | "offline" | "disabled" | "unknown";
  lastSeenAt: string | null;
  lastEventAt: string | null;
  bridgeVersion: string | null;
  firmwareVersion: string | null;
  pendingLocalEvents: number | null;
}

export interface DeviceEnrollment {
  id: string;
  deviceId: string;
  employeeId: string;
  employeeNo: string;
  state: "user_pending" | "user_synced" | "queued" | "capturing" | "enrolled" | "failed";
  fingerPrintId: number | null;
  quality: number | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface UnmappedIdentity {
  id: string;
  deviceId: string;
  deviceName: string;
  employeeNo: string;
  deviceEmployeeName: string;
  eventCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface TrendPoint {
  date: string;
  present: number;
  absent: number;
  late: number;
  leave: number;
}

export interface DashboardSnapshot {
  employeeCount: number;
  presentToday: number;
  absentToday: number;
  lateToday: number;
  leaveToday: number;
  totalLateMinutes: number;
  totalOvertimeMinutes: number;
  missingPunches: number;
  devicesOffline: number;
  unmappedEvents: number;
  attendance: AttendanceDay[];
  devices: Device[];
  trend: TrendPoint[];
}

export interface EmployeeDetail {
  employee: Employee;
  days: AttendanceDay[];
}

export interface ReportFilters {
  from: string;
  to: string;
  employeeId?: string;
  departmentId?: string;
  branchId?: string;
  shiftId?: string;
  status?: AttendanceDisplayStatus;
}

export interface ReportSummaryRow {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  departmentName: string;
  workingDays: number;
  presentDays: number;
  absentDays: number;
  leaveDays: number;
  lateDays: number;
  totalLateMinutes: number;
  earlyLeaveDays: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  totalWorkedMinutes: number;
}
