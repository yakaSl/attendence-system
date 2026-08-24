"use client";

import { ArrowRight, Search, UserRoundCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState, type FormEvent } from "react";

import { Button, EmptyState, ErrorState, LoadingState, Modal, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import type { Employee, UnmappedIdentity } from "@/lib/data/types";
import { useData } from "@/lib/data/data-provider";
import { mapDeviceIdentity } from "@/lib/firebase/actions";
import { formatMinutes, initials, todayKey } from "@/lib/format";
import { useAsyncData } from "@/lib/use-async-data";

interface EmployeesData {
  employees: Employee[];
  unmapped: UnmappedIdentity[];
}

export default function EmployeesPage() {
  const { user } = useAuth();
  const { repository, organization } = useData();
  const date = todayKey(organization?.timezone);
  const load = useCallback(async (): Promise<EmployeesData> => {
    const organizationId = user?.organizationId ?? "";
    const [employees, unmapped] = await Promise.all([
      repository.getEmployees(organizationId, date),
      repository.getUnmappedIdentities(organizationId),
    ]);
    return { employees, unmapped };
  }, [date, repository, user?.organizationId]);
  const { data, loading, error, refresh } = useAsyncData(load);
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [status, setStatus] = useState("");
  const [mapping, setMapping] = useState<UnmappedIdentity | null>(null);
  const [hiddenMappings, setHiddenMappings] = useState<string[]>([]);

  const departments = useMemo(() => [...new Set(data?.employees.map((employee) => employee.departmentName) ?? [])].sort(), [data]);
  const rows = useMemo(() => (data?.employees ?? []).filter((employee) => {
    const needle = search.trim().toLowerCase();
    return (needle === "" || `${employee.name} ${employee.employeeCode}`.toLowerCase().includes(needle)) &&
      (department === "" || employee.departmentName === department) &&
      (status === "" || employee.todayStatus === status);
  }), [data, department, search, status]);
  const openUnmapped = (data?.unmapped ?? []).filter((identity) => !hiddenMappings.includes(identity.id));

  return (
    <>
      <PageHeader eyebrow="People operations" title="Employees" description="Search workforce records, inspect monthly attendance, and connect device identities to cloud employees." />
      {openUnmapped.length > 0 ? (
        <div className="attention-banner">
          <div><span className="attention-icon"><UserRoundCheck size={18} /></span><span><strong>Unmapped attendance events: {openUnmapped.reduce((sum, item) => sum + item.eventCount, 0)}</strong><small>Connect device user numbers before payroll review.</small></span></div>
          {user && ["organizationOwner", "hrAdmin", "platformAdmin"].includes(user.role) ? <Button variant="secondary" onClick={() => setMapping(openUnmapped[0] ?? null)}>Resolve identities</Button> : null}
        </div>
      ) : null}
      <div className="filter-bar">
        <div className="filter-field filter-field-wide"><label htmlFor="employee-search">Search</label><div className="input-with-icon"><Search size={14} /><input id="employee-search" placeholder="Name or employee code" value={search} onChange={(event) => setSearch(event.target.value)} /></div></div>
        <div className="filter-field"><label htmlFor="department-filter">Department</label><select id="department-filter" value={department} onChange={(event) => setDepartment(event.target.value)}><option value="">All departments</option>{departments.map((value) => <option key={value}>{value}</option>)}</select></div>
        <div className="filter-field"><label htmlFor="today-filter">Today</label><select id="today-filter" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="present">Present</option><option value="absent">Absent</option><option value="leave">On leave</option><option value="missing_punch">Missing punch</option></select></div>
        <div className="filter-count">{rows.length} employees</div>
      </div>

      <Panel>
        {loading ? <LoadingState label="Loading employees" /> : error ? <ErrorState message={error} /> : rows.length === 0 ? <EmptyState title="No employees found" message="Change the search or filters to broaden the result." /> : (
          <div className="table-wrap"><table className="data-table responsive-table"><thead><tr><th>Employee</th><th>Employee code</th><th>Department</th><th>Shift</th><th>Today</th><th>Last punch</th><th>Late this month</th><th>OT this month</th><th aria-label="Open" /></tr></thead><tbody>
            {rows.map((employee) => <tr key={employee.id}>
              <td data-label="Employee" data-primary="true"><Link href={`/employees/${employee.id}`} className="cell-main"><span className="cell-avatar">{initials(employee.name)}</span><span className="cell-copy"><strong>{employee.name}</strong><small>{employee.branchName}</small></span></Link></td>
              <td data-label="Employee code" className="numeric">{employee.employeeCode}</td><td data-label="Department">{employee.departmentName}</td><td data-label="Shift">{employee.shiftName}</td><td data-label="Today"><StatusBadge status={employee.todayStatus} /></td><td data-label="Last punch" className="numeric">{employee.lastPunch ?? "—"}</td><td data-label="Late this month" className={employee.lateMinutesThisMonth > 0 ? "numeric warning-text" : "numeric muted"}>{formatMinutes(employee.lateMinutesThisMonth, true)}</td><td data-label="OT this month" className={employee.overtimeMinutesThisMonth > 0 ? "numeric positive-text" : "numeric muted"}>{formatMinutes(employee.overtimeMinutesThisMonth, true)}</td><td data-action="true"><Link className="row-link" href={`/employees/${employee.id}`} aria-label={`Open ${employee.name}`}><ArrowRight size={15} /></Link></td>
            </tr>)}
          </tbody></table></div>
        )}
      </Panel>

      <MappingModal
        identity={mapping}
        employees={data?.employees ?? []}
        organizationId={user?.organizationId ?? ""}
        onClose={() => setMapping(null)}
        onMapped={(identityId) => { setHiddenMappings((current) => [...current, identityId]); setMapping(null); refresh(); }}
      />
    </>
  );
}

function MappingModal({ identity, employees, organizationId, onClose, onMapped }: {
  identity: UnmappedIdentity | null;
  employees: Employee[];
  organizationId: string;
  onClose(): void;
  onMapped(identityId: string): void;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [reason, setReason] = useState("Confirmed against HR employee register");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (identity === null) return;
    setSubmitting(true); setError(null);
    try {
      await mapDeviceIdentity({ organizationId, deviceId: identity.deviceId, employeeNo: identity.employeeNo, employeeId, reason });
      onMapped(identity.id);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Identity could not be mapped");
    } finally { setSubmitting(false); }
  }

  return <Modal open={identity !== null} title="Map device identity" description="Historical raw events will be recalculated; the source evidence will not be edited." onClose={onClose}>
    {identity ? <form className="modal-content" onSubmit={submit}>
      <div className="mapping-preview"><div><small>Device identity</small><strong>User {identity.employeeNo} · {identity.deviceEmployeeName}</strong><span>{identity.deviceName} · {identity.eventCount} event{identity.eventCount === 1 ? "" : "s"}</span></div><ArrowRight size={18} /><div><small>Cloud employee</small><strong>{employees.find((employee) => employee.id === employeeId)?.name ?? "Select employee"}</strong><span>{employees.find((employee) => employee.id === employeeId)?.employeeCode ?? "Not mapped"}</span></div></div>
      {error ? <ErrorState message={error} /> : null}
      <div className="form-grid"><div className="form-field form-field-full"><label htmlFor="mapping-employee">Employee</label><select id="mapping-employee" required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">Select employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeCode} · {employee.name}</option>)}</select></div><div className="form-field form-field-full"><label htmlFor="mapping-reason">Reason</label><textarea id="mapping-reason" required minLength={3} value={reason} onChange={(event) => setReason(event.target.value)} /></div></div>
      <div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={submitting || employeeId === ""}>{submitting ? "Mapping…" : "Map and recalculate"}</Button></div>
    </form> : null}
  </Modal>;
}
