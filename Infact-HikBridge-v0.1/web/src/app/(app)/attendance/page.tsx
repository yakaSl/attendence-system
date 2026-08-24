"use client";

import { Temporal } from "@js-temporal/polyfill";
import { CalendarClock, RotateCcw } from "lucide-react";
import { useCallback, useMemo, useState, type FormEvent } from "react";

import { AttendanceTable } from "@/components/attendance-table";
import { Button, ErrorState, LoadingState, Modal, PageHeader, Panel } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import { useData } from "@/lib/data/data-provider";
import type { AttendanceDay, Department, Employee, ReportFilters } from "@/lib/data/types";
import { createManualAdjustment } from "@/lib/firebase/actions";
import { formatDate, todayKey } from "@/lib/format";
import { useAsyncData } from "@/lib/use-async-data";

interface AttendanceData {
  days: AttendanceDay[];
  employees: Employee[];
  departments: Department[];
}

export default function AttendancePage() {
  const { user } = useAuth();
  const { repository, organization } = useData();
  const [date, setDate] = useState(todayKey(organization?.timezone));
  const [employeeId, setEmployeeId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [status, setStatus] = useState("");
  const [correction, setCorrection] = useState<AttendanceDay | null>(null);
  const filters = useMemo<ReportFilters>(() => ({
    from: date,
    to: date,
    ...(employeeId ? { employeeId } : {}),
    ...(departmentId ? { departmentId } : {}),
    ...(branchId ? { branchId } : {}),
    ...(status ? { status: status as ReportFilters["status"] } : {}),
  }), [branchId, date, departmentId, employeeId, status]);
  const load = useCallback(async (): Promise<AttendanceData> => {
    const organizationId = user?.organizationId ?? "";
    const [days, employees, departments] = await Promise.all([
      repository.getAttendance(organizationId, filters),
      repository.getEmployees(organizationId, date),
      repository.getDepartments(organizationId),
    ]);
    return { days, employees, departments };
  }, [date, filters, repository, user?.organizationId]);
  const { data, loading, error, refresh } = useAsyncData(load);
  const branches = useMemo(() => {
    const map = new Map((data?.employees ?? []).map((employee) => [employee.branchId ?? "", employee.branchName]));
    map.delete("");
    return [...map].sort((left, right) => left[1].localeCompare(right[1]));
  }, [data]);
  const canCorrect = user !== null && ["organizationOwner", "hrAdmin", "platformAdmin"].includes(user.role);

  return (
    <>
      <PageHeader eyebrow="Daily operations" title="Attendance" description={`Calculated attendance for ${formatDate(date, { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}.`} actions={<Button variant="secondary" onClick={refresh}><RotateCcw size={14} />Refresh</Button>} />
      <div className="filter-bar">
        <div className="filter-field"><label htmlFor="attendance-date">Date</label><input id="attendance-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></div>
        <div className="filter-field filter-field-wide"><label htmlFor="attendance-employee">Employee</label><select id="attendance-employee" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">All employees</option>{data?.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeCode} · {employee.name}</option>)}</select></div>
        <div className="filter-field"><label htmlFor="attendance-department">Department</label><select id="attendance-department" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">All departments</option>{data?.departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></div>
        <div className="filter-field"><label htmlFor="attendance-status">Status</label><select id="attendance-status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="present">Present</option><option value="absent">Absent</option><option value="leave">On leave</option><option value="missing_punch">Missing punch</option><option value="holiday">Holiday</option></select></div>
        <div className="filter-field"><label htmlFor="attendance-branch">Branch</label><select id="attendance-branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">All branches</option>{branches.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></div>
      </div>
      <Panel title="Calculated workdays" description={`${data?.days.length ?? 0} employee rows · source events remain immutable`}>
        {loading ? <LoadingState label="Loading attendance" /> : error ? <ErrorState message={error} /> : <AttendanceTable days={data?.days ?? []} onCorrect={canCorrect ? setCorrection : undefined} />}
      </Panel>
      <CorrectionModal
        day={correction}
        timezone={organization?.timezone ?? "UTC"}
        organizationId={user?.organizationId ?? ""}
        onClose={() => setCorrection(null)}
        onSaved={() => { setCorrection(null); refresh(); }}
      />
    </>
  );
}

type CorrectionKind = "set_first_in" | "set_last_out" | "clear_first_in" | "clear_last_out" | "set_status";

function correctedInstant(day: AttendanceDay, time: string, kind: CorrectionKind, timezone: string): string {
  let date = Temporal.PlainDate.from(day.date);
  const plainTime = Temporal.PlainTime.from(time);
  if (
    kind === "set_last_out" &&
    day.scheduledIn !== null &&
    day.scheduledOut !== null &&
    Temporal.PlainTime.compare(Temporal.PlainTime.from(day.scheduledOut), Temporal.PlainTime.from(day.scheduledIn)) <= 0 &&
    Temporal.PlainTime.compare(plainTime, Temporal.PlainTime.from(day.scheduledIn)) <= 0
  ) {
    date = date.add({ days: 1 });
  }
  return date.toZonedDateTime({ timeZone: timezone, plainTime }).toInstant().toString();
}

function CorrectionModal({ day, timezone, organizationId, onClose, onSaved }: {
  day: AttendanceDay | null;
  timezone: string;
  organizationId: string;
  onClose(): void;
  onSaved(): void;
}) {
  const [kind, setKind] = useState<CorrectionKind>("set_last_out");
  const [time, setTime] = useState("17:35");
  const [status, setStatus] = useState<"present" | "absent" | "leave">("present");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (day === null) return;
    setSubmitting(true); setError(null);
    try {
      const needsTime = kind === "set_first_in" || kind === "set_last_out";
      await createManualAdjustment({
        organizationId,
        employeeId: day.employeeId,
        date: day.date,
        requestId: crypto.randomUUID(),
        kind,
        ...(needsTime ? { occurredAt: correctedInstant(day, time, kind, timezone) } : {}),
        ...(kind === "set_status" ? { status } : {}),
        reason,
      });
      onSaved();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Correction could not be saved");
    } finally { setSubmitting(false); }
  }

  return <Modal open={day !== null} title="Correct attendance" description="This creates a separate immutable adjustment and audit record." onClose={onClose}>
    {day ? <form className="modal-content" onSubmit={submit}>
      <div className="correction-context"><CalendarClock size={18} /><div><strong>{day.employeeName}</strong><small>{formatDate(day.date)} · Current {day.firstIn ?? "—"} to {day.lastOut ?? "—"}</small></div></div>
      {error ? <ErrorState message={error} /> : null}
      <div className="form-grid">
        <div className="form-field form-field-full"><label htmlFor="correction-kind">Correction</label><select id="correction-kind" value={kind} onChange={(event) => setKind(event.target.value as CorrectionKind)}><option value="set_last_out">Set checkout time</option><option value="set_first_in">Set check-in time</option><option value="clear_last_out">Clear checkout</option><option value="clear_first_in">Clear check-in</option><option value="set_status">Set day status</option></select></div>
        {kind === "set_first_in" || kind === "set_last_out" ? <div className="form-field"><label htmlFor="correction-time">Corrected time</label><input id="correction-time" type="time" required value={time} onChange={(event) => setTime(event.target.value)} /></div> : null}
        {kind === "set_status" ? <div className="form-field"><label htmlFor="correction-status">Status</label><select id="correction-status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="present">Present</option><option value="absent">Absent</option><option value="leave">Leave</option></select></div> : null}
        <div className="form-field form-field-full"><label htmlFor="correction-reason">Reason</label><textarea id="correction-reason" placeholder="Example: Fingerprint terminal power failure" required minLength={3} value={reason} onChange={(event) => setReason(event.target.value)} /></div>
      </div>
      <div className="audit-note">The old calculated state, this adjustment, your account, reason, timestamp, and new calculated state will be retained.</div>
      <div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={submitting}>{submitting ? "Saving…" : "Save correction"}</Button></div>
    </form> : null}
  </Modal>;
}
