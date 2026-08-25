import type { AttendanceDay, ReportSummaryRow } from "./types";

export function summarizeAttendance(days: AttendanceDay[]): ReportSummaryRow[] {
  const rows = new Map<string, ReportSummaryRow>();
  for (const day of days) {
    const row = rows.get(day.employeeId) ?? {
      employeeId: day.employeeId,
      employeeCode: day.employeeCode,
      employeeName: day.employeeName,
      departmentName: day.departmentName,
      workingDays: 0,
      presentDays: 0,
      absentDays: 0,
      leaveDays: 0,
      lateDays: 0,
      totalLateMinutes: 0,
      earlyLeaveDays: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
      totalWorkedMinutes: 0,
    };
    if (day.status !== "rest_day" && day.status !== "holiday" && day.status !== "no_shift") row.workingDays++;
    if (day.status === "present") row.presentDays++;
    if (day.status === "absent") row.absentDays++;
    if (day.status === "leave") row.leaveDays++;
    if (day.lateMinutes > 0) row.lateDays++;
    if (day.earlyLeaveMinutes > 0) row.earlyLeaveDays++;
    row.totalLateMinutes += day.lateMinutes;
    row.earlyLeaveMinutes += day.earlyLeaveMinutes;
    row.overtimeMinutes += day.overtimeMinutes;
    row.totalWorkedMinutes += day.workedMinutes;
    rows.set(day.employeeId, row);
  }
  return [...rows.values()].sort((left, right) => left.employeeName.localeCompare(right.employeeName));
}

function csvValue(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function monthlySummaryCsv(rows: ReportSummaryRow[]): string {
  const header = [
    "Employee Code", "Employee Name", "Department", "Working Days", "Present Days", "Absent Days", "Leave Days",
    "Late Days", "Total Late Minutes", "Early Leave Days", "Early Leave Minutes", "Overtime Hours", "Total Worked Hours",
  ];
  const body = rows.map((row) => [
    row.employeeCode,
    row.employeeName,
    row.departmentName,
    row.workingDays,
    row.presentDays,
    row.absentDays,
    row.leaveDays,
    row.lateDays,
    row.totalLateMinutes,
    row.earlyLeaveDays,
    row.earlyLeaveMinutes,
    (row.overtimeMinutes / 60).toFixed(2),
    (row.totalWorkedMinutes / 60).toFixed(2),
  ]);
  return [header, ...body].map((row) => row.map(csvValue).join(",")).join("\r\n");
}

export function attendanceCsv(days: AttendanceDay[]): string {
  const header = ["Date", "Employee Code", "Employee Name", "Department", "Branch", "Shift", "Scheduled In", "Scheduled Out", "First In", "Last Out", "Worked Minutes", "Late Minutes", "Early Leave Minutes", "Overtime Minutes", "Status", "Exceptions", "Adjusted"];
  const body = days.map((day) => [day.date, day.employeeCode, day.employeeName, day.departmentName, day.branchName, day.shiftName, day.scheduledIn ?? "", day.scheduledOut ?? "", day.firstIn ?? "", day.lastOut ?? "", day.workedMinutes, day.lateMinutes, day.earlyLeaveMinutes, day.overtimeMinutes, day.status, day.exceptions.join("|"), day.hasManualAdjustment ? "yes" : "no"]);
  return [header, ...body].map((row) => row.map(csvValue).join(",")).join("\r\n");
}
