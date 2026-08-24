"use client";

import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, ClockAlert, PencilLine, Timer, UserCheck, UserMinus } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useMemo, useState, type FormEvent } from "react";

import { AttendanceTable } from "@/components/attendance-table";
import { Button, ErrorState, LoadingState, Metric, Modal, PageHeader, Panel, RoleGate, StatusBadge } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import { useData } from "@/lib/data/data-provider";
import type { Department, Employee } from "@/lib/data/types";
import { updateEmployeeDepartment } from "@/lib/firebase/actions";
import { formatMinutes, formatMonth, initials, monthKey } from "@/lib/format";
import { useAsyncData } from "@/lib/use-async-data";

function moveMonth(month: string, offset: number): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

export default function EmployeeDetailPage({ params }: { params: Promise<{ employeeId: string }> }) {
  const { employeeId } = use(params);
  const { user } = useAuth();
  const { repository, organization } = useData();
  const [month, setMonth] = useState(monthKey(organization?.timezone));
  const [editingDepartment, setEditingDepartment] = useState(false);
  const load = useCallback(
    () => repository.getEmployeeDetail(user?.organizationId ?? "", employeeId, month),
    [employeeId, month, repository, user?.organizationId],
  );
  const loadDepartments = useCallback(
    () => repository.getDepartments(user?.organizationId ?? ""),
    [repository, user?.organizationId],
  );
  const { data, loading, error, refresh } = useAsyncData(load);
  const { data: departments, loading: departmentsLoading, error: departmentsError } = useAsyncData(loadDepartments);
  const summary = useMemo(() => {
    const days = data?.days ?? [];
    return {
      present: days.filter((day) => day.status === "present").length,
      absent: days.filter((day) => day.status === "absent").length,
      leave: days.filter((day) => day.status === "leave").length,
      lateDays: days.filter((day) => day.lateMinutes > 0).length,
      lateMinutes: days.reduce((sum, day) => sum + day.lateMinutes, 0),
      overtime: days.reduce((sum, day) => sum + day.overtimeMinutes, 0),
      worked: days.reduce((sum, day) => sum + day.workedMinutes, 0),
    };
  }, [data]);

  return (
    <>
      <div className="back-row"><Link href="/employees"><ArrowLeft size={14} />Employees</Link></div>
      {loading ? <Panel><LoadingState label="Loading employee record" /></Panel> : error ? <ErrorState message={error} /> : data === null ? <Panel><ErrorState message="Employee was not found" /></Panel> : (
        <>
          <PageHeader
            eyebrow="Employee attendance"
            title={data.employee.name}
            description={`${data.employee.employeeCode} · ${data.employee.departmentName} · ${data.employee.branchName}`}
            actions={<><StatusBadge status={data.employee.todayStatus} /><RoleGate role={user?.role ?? "viewer"} allowed={["organizationOwner", "hrAdmin"]}><Button variant="secondary" onClick={() => setEditingDepartment(true)}><PencilLine size={14} aria-hidden />Change department</Button></RoleGate></>}
          />
          <section className="employee-profile-strip">
            <span className="profile-avatar">{initials(data.employee.name)}</span>
            <div><small>Employee</small><strong>{data.employee.employeeCode}</strong></div>
            <div><small>Department</small><strong>{data.employee.departmentName}</strong></div>
            <div><small>Assigned shift</small><strong>{data.employee.shiftName}</strong></div>
            <div><small>Branch</small><strong>{data.employee.branchName}</strong></div>
          </section>

          <div className="month-toolbar"><div><button className="icon-button" onClick={() => setMonth(moveMonth(month, -1))} aria-label="Previous month"><ChevronLeft size={16} /></button><strong>{formatMonth(month)}</strong><button className="icon-button" onClick={() => setMonth(moveMonth(month, 1))} aria-label="Next month"><ChevronRight size={16} /></button></div><input aria-label="Select month" type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></div>

          <div className="metric-grid employee-metrics">
            <Metric label="Present" value={summary.present} tone="positive" icon={UserCheck} />
            <Metric label="Absent" value={summary.absent} tone={summary.absent > 0 ? "danger" : "neutral"} icon={UserMinus} />
            <Metric label="Leave" value={summary.leave} icon={CalendarDays} />
            <Metric label="Late days" value={summary.lateDays} tone={summary.lateDays > 0 ? "warning" : "neutral"} icon={ClockAlert} />
            <Metric label="Late time" value={formatMinutes(summary.lateMinutes, true)} tone={summary.lateMinutes > 0 ? "warning" : "neutral"} icon={Timer} />
            <Metric label="Overtime" value={formatMinutes(summary.overtime, true)} tone="positive" />
            <Metric label="Total worked" value={formatMinutes(summary.worked, true)} />
          </div>
          <Panel title="Monthly attendance" description={`${data.days.length} calculated workdays`} action={<Button variant="secondary" onClick={() => window.print()}>Print view</Button>}>
            <AttendanceTable days={data.days} showEmployee={false} />
          </Panel>
        </>
      )}
      {editingDepartment && data !== null ? <DepartmentAssignmentModal
        employee={data.employee}
        organizationId={user?.organizationId ?? ""}
        departments={departments ?? []}
        departmentsLoading={departmentsLoading}
        departmentsError={departmentsError}
        onClose={() => setEditingDepartment(false)}
        onSaved={() => { setEditingDepartment(false); refresh(); }}
      /> : null}
    </>
  );
}

function DepartmentAssignmentModal({
  employee,
  organizationId,
  departments,
  departmentsLoading,
  departmentsError,
  onClose,
  onSaved,
}: {
  employee: Employee;
  organizationId: string;
  departments: Department[];
  departmentsLoading: boolean;
  departmentsError: string | null;
  onClose(): void;
  onSaved(): void;
}) {
  const currentDepartmentId = employee.departmentId ?? "";
  const [departmentId, setDepartmentId] = useState(currentDepartmentId);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateEmployeeDepartment({
        organizationId,
        employeeId: employee.id,
        departmentId: departmentId || null,
        reason,
      });
      onSaved();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Department could not be changed");
    } finally {
      setSubmitting(false);
    }
  }

  return <Modal
    open
    title="Change department"
    description={`${employee.employeeCode} · ${employee.name} is currently assigned to ${employee.departmentName}.`}
    onClose={onClose}
  >
    <form className="modal-content" onSubmit={submit}>
      {error ? <ErrorState message={error} /> : null}
      {departmentsError ? <ErrorState message="Departments could not be loaded. Close this window and try again." /> : null}
      <div className="form-grid">
        <div className="form-field form-field-full">
          <label htmlFor="employee-department">New department</label>
          <select
            id="employee-department"
            autoFocus
            disabled={departmentsLoading || departmentsError !== null}
            value={departmentId}
            onChange={(event) => setDepartmentId(event.target.value)}
          >
            <option value="">Unassigned</option>
            {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
          </select>
          <small>Fingerprint enrollment and terminal identity will not be changed.</small>
        </div>
        <div className="form-field form-field-full">
          <label htmlFor="department-change-reason">Reason</label>
          <textarea
            id="department-change-reason"
            required
            minLength={3}
            maxLength={500}
            placeholder="Transferred to another team"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>
      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        <Button
          type="submit"
          disabled={submitting || departmentsLoading || departmentsError !== null || departmentId === currentDepartmentId || reason.trim().length < 3}
        >
          {submitting ? "Saving…" : "Save department"}
        </Button>
      </div>
    </form>
  </Modal>;
}
