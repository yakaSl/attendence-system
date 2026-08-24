"use client";

import { Temporal } from "@js-temporal/polyfill";
import { Download, FileSpreadsheet, ShieldCheck } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { AttendanceTable } from "@/components/attendance-table";
import { Button, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import { useData } from "@/lib/data/data-provider";
import { attendanceCsv, monthlySummaryCsv, summarizeAttendance } from "@/lib/data/reporting";
import type { AttendanceDay, Department, Employee, ReportFilters, Shift } from "@/lib/data/types";
import { formatMinutes, todayKey } from "@/lib/format";
import { useAsyncData } from "@/lib/use-async-data";

type ReportType = "daily" | "monthly_employee" | "monthly_company" | "late" | "overtime" | "absent" | "missing";
interface ReportData { days: AttendanceDay[]; employees: Employee[]; departments: Department[]; shifts: Shift[] }

const reportLabels: Record<ReportType, string> = {
  daily: "Daily attendance",
  monthly_employee: "Monthly employee",
  monthly_company: "Monthly company attendance",
  late: "Late arrivals",
  overtime: "Overtime",
  absent: "Absences",
  missing: "Missing punches",
};

export default function ReportsPage() {
  const { user } = useAuth();
  const { repository, organization } = useData();
  const today = todayKey(organization?.timezone);
  const [type, setType] = useState<ReportType>("monthly_company");
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [employeeId, setEmployeeId] = useState(""); const [departmentId, setDepartmentId] = useState(""); const [branchId, setBranchId] = useState(""); const [shiftId, setShiftId] = useState("");
  const daysInRange = Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to), { largestUnit: "days" }).days + 1;
  const rangeError = daysInRange < 1 ? "End date must not precede start date." : daysInRange > 31 ? "Interactive reports are limited to 31 days. Split larger ranges or use a scheduled export." : null;
  const filters = useMemo<ReportFilters>(() => ({ from, to, ...(employeeId ? { employeeId } : {}), ...(departmentId ? { departmentId } : {}), ...(branchId ? { branchId } : {}), ...(shiftId ? { shiftId } : {}) }), [branchId, departmentId, employeeId, from, shiftId, to]);
  const load = useCallback(async (): Promise<ReportData> => {
    const organizationId = user?.organizationId ?? "";
    const [employees, departments, shifts] = await Promise.all([repository.getEmployees(organizationId, to), repository.getDepartments(organizationId), repository.getShifts(organizationId)]);
    const days = rangeError === null ? await repository.getAttendance(organizationId, filters) : [];
    return { days, employees, departments, shifts };
  }, [filters, rangeError, repository, to, user?.organizationId]);
  const { data, loading, error } = useAsyncData(load);
  const branches = useMemo(() => [...new Map((data?.employees ?? []).filter((employee) => employee.branchId).map((employee) => [employee.branchId as string, employee.branchName]))].sort((left, right) => left[1].localeCompare(right[1])), [data]);
  const reportDays = useMemo(() => (data?.days ?? []).filter((day) => {
    if (type === "late") return day.lateMinutes > 0;
    if (type === "overtime") return day.overtimeMinutes > 0;
    if (type === "absent") return day.status === "absent";
    if (type === "missing") return day.exceptions.some((value) => value.startsWith("missing_"));
    return true;
  }), [data, type]);
  const summary = useMemo(() => summarizeAttendance(reportDays), [reportDays]);
  const summaryMode = type === "monthly_company" || type === "monthly_employee";

  function download() {
    const content = summaryMode ? monthlySummaryCsv(summary) : attendanceCsv(reportDays);
    const url = URL.createObjectURL(new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `infact-${type}-${from}-${to}.csv`; anchor.click(); URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader eyebrow="Controlled exports" title="Reports" description="Generate payroll-ready daily, monthly, exception, and overtime views without downloading the entire database." actions={<Button onClick={download} disabled={loading || reportDays.length === 0 || rangeError !== null}><Download size={14} />Export CSV</Button>} />
      <div className="report-type-strip">{(Object.keys(reportLabels) as ReportType[]).map((value) => <button key={value} data-active={type === value} onClick={() => setType(value)}>{reportLabels[value]}</button>)}</div>
      <div className="filter-bar">
        <div className="filter-field"><label htmlFor="report-from">From</label><input id="report-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></div><div className="filter-field"><label htmlFor="report-to">To</label><input id="report-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></div>
        <div className="filter-field filter-field-wide"><label htmlFor="report-employee">Employee</label><select id="report-employee" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">All employees</option>{data?.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeCode} · {employee.name}</option>)}</select></div>
        <div className="filter-field"><label htmlFor="report-department">Department</label><select id="report-department" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">All departments</option>{data?.departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></div>
        <div className="filter-field"><label htmlFor="report-branch">Branch</label><select id="report-branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">All branches</option>{branches.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></div>
        <div className="filter-field"><label htmlFor="report-shift">Shift</label><select id="report-shift" value={shiftId} onChange={(event) => setShiftId(event.target.value)}><option value="">All shifts</option>{data?.shifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.name}</option>)}</select></div>
      </div>
      {rangeError ? <ErrorState message={rangeError} /> : null}
      <div className="report-assurance"><ShieldCheck size={15} /><span>Interactive query cap: 31 days and 5,000 calculated rows. CSV contains derived attendance only—never bridge credentials or raw private payloads.</span></div>
      <Panel title={reportLabels[type]} description={`${reportDays.length} calculated rows · ${summary.length} employees`} action={<span className="report-total"><FileSpreadsheet size={14} />{summary.reduce((sum, row) => sum + row.totalWorkedMinutes, 0) ? formatMinutes(summary.reduce((sum, row) => sum + row.totalWorkedMinutes, 0)) : "No worked time"}</span>}>
        {loading ? <LoadingState label="Preparing report" /> : error ? <ErrorState message={error} /> : reportDays.length === 0 ? <EmptyState title="No report rows" message="No calculated attendance matches the selected report and filters." /> : summaryMode ? (
          <div className="table-wrap"><table className="data-table responsive-table"><thead><tr><th>Employee</th><th>Department</th><th>Working</th><th>Present</th><th>Absent</th><th>Leave</th><th>Late days</th><th>Late time</th><th>Early days</th><th>Early time</th><th>OT</th><th>Worked</th></tr></thead><tbody>{summary.map((row) => <tr key={row.employeeId}><td data-label="Employee" data-primary="true"><span className="cell-copy"><strong>{row.employeeName}</strong><small>{row.employeeCode}</small></span></td><td data-label="Department">{row.departmentName}</td><td data-label="Working days">{row.workingDays}</td><td data-label="Present" className="positive-text">{row.presentDays}</td><td data-label="Absent" className={row.absentDays ? "danger-text" : "muted"}>{row.absentDays}</td><td data-label="Leave">{row.leaveDays}</td><td data-label="Late days">{row.lateDays}</td><td data-label="Late time" className="warning-text">{formatMinutes(row.totalLateMinutes, true)}</td><td data-label="Early days">{row.earlyLeaveDays}</td><td data-label="Early time">{formatMinutes(row.earlyLeaveMinutes, true)}</td><td data-label="Overtime" className="positive-text">{formatMinutes(row.overtimeMinutes, true)}</td><td data-label="Worked">{formatMinutes(row.totalWorkedMinutes, true)}</td></tr>)}</tbody></table></div>
        ) : <AttendanceTable days={reportDays} />}
      </Panel>
    </>
  );
}
