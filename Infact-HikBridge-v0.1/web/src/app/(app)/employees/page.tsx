"use client";

import { ArrowRight, Fingerprint, Plus, Search, UserRoundCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { SortableHeader } from "@/components/sortable-header";
import { Button, EmptyState, ErrorState, LoadingState, Modal, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import type { Branch, Department, Device, DeviceEnrollment, Employee, UnmappedIdentity } from "@/lib/data/types";
import { useData } from "@/lib/data/data-provider";
import { createEmployee, mapDeviceIdentity, requestFingerprintEnrollment } from "@/lib/firebase/actions";
import { formatMinutes, initials, todayKey } from "@/lib/format";
import { nextSort, sortRows, type SortState } from "@/lib/sorting";
import { useAsyncData } from "@/lib/use-async-data";

interface EmployeesData {
  employees: Employee[];
  unmapped: UnmappedIdentity[];
  branches: Branch[];
  departments: Department[];
  devices: Device[];
  enrollments: DeviceEnrollment[];
}

type EmployeeSort = "employee" | "code" | "department" | "shift" | "fingerprint" | "today" | "lastPunch" | "late" | "overtime";

export default function EmployeesPage() {
  const { user } = useAuth();
  const { repository, organization } = useData();
  const date = todayKey(organization?.timezone);
  const canManage = user !== null && ["organizationOwner", "hrAdmin", "platformAdmin"].includes(user.role);
  const load = useCallback(async (): Promise<EmployeesData> => {
    const organizationId = user?.organizationId ?? "";
    const [employees, unmapped, branches, departments, devices, enrollments] = await Promise.all([
      repository.getEmployees(organizationId, date),
      canManage ? repository.getUnmappedIdentities(organizationId) : Promise.resolve([]),
      repository.getBranches(organizationId),
      repository.getDepartments(organizationId),
      repository.getDevices(organizationId),
      canManage ? repository.getDeviceEnrollments(organizationId) : Promise.resolve([]),
    ]);
    return { employees, unmapped, branches, departments, devices, enrollments };
  }, [canManage, date, repository, user?.organizationId]);
  const { data, loading, error, refresh } = useAsyncData(load);
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<SortState<EmployeeSort>>({ key: "employee", direction: "asc" });
  const [mapping, setMapping] = useState<UnmappedIdentity | null>(null);
  const [creating, setCreating] = useState(false);
  const [enrolling, setEnrolling] = useState<Employee | null>(null);
  const [hiddenMappings, setHiddenMappings] = useState<string[]>([]);

  const departments = useMemo(() => [...new Set(data?.employees.map((employee) => employee.departmentName) ?? [])].sort(), [data]);
  const filteredRows = useMemo(() => (data?.employees ?? []).filter((employee) => {
    const needle = search.trim().toLowerCase();
    return (needle === "" || `${employee.name} ${employee.employeeCode}`.toLowerCase().includes(needle)) &&
      (department === "" || employee.departmentName === department) &&
      (status === "" || employee.todayStatus === status);
  }), [data, department, search, status]);
  const rows = useMemo(() => sortRows(filteredRows, sort, {
    employee: (employee) => employee.name,
    code: (employee) => employee.employeeCode,
    department: (employee) => employee.departmentName,
    shift: (employee) => employee.shiftName,
    fingerprint: (employee) => newestEnrollment(data?.enrollments ?? [], employee.id)?.state ?? "none",
    today: (employee) => employee.todayStatus,
    lastPunch: (employee) => employee.lastPunch,
    late: (employee) => employee.lateMinutesThisMonth,
    overtime: (employee) => employee.overtimeMinutesThisMonth,
  }), [data?.enrollments, filteredRows, sort]);
  const requestSort = (key: EmployeeSort) => setSort((current) => nextSort(current, key));
  const openUnmapped = (data?.unmapped ?? []).filter((identity) => !hiddenMappings.includes(identity.id));
  const hasActiveEnrollment = (data?.enrollments ?? []).some((enrollment) => ["user_pending", "queued", "capturing"].includes(enrollment.state));

  useEffect(() => {
    if (!hasActiveEnrollment) return;
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [hasActiveEnrollment, refresh]);

  return (
    <>
      <PageHeader eyebrow="People operations" title="Employees" description="Create workforce records, provision terminal users, and enroll fingerprints without exposing biometric templates to the cloud." actions={canManage ? <Button onClick={() => setCreating(true)}><Plus size={15} />Add employee</Button> : null} />
      {openUnmapped.length > 0 ? (
        <div className="attention-banner">
          <div><span className="attention-icon"><UserRoundCheck size={18} /></span><span><strong>Unmapped attendance events: {openUnmapped.reduce((sum, item) => sum + item.eventCount, 0)}</strong><small>Connect device user numbers before payroll review.</small></span></div>
          {canManage ? <Button variant="secondary" onClick={() => setMapping(openUnmapped[0] ?? null)}>Resolve identities</Button> : null}
        </div>
      ) : null}
      <div className="filter-bar">
        <div className="filter-field filter-field-wide"><label htmlFor="employee-search">Search</label><div className="input-with-icon"><Search size={14} /><input id="employee-search" placeholder="Name or employee code" value={search} onChange={(event) => setSearch(event.target.value)} /></div></div>
        <div className="filter-field"><label htmlFor="department-filter">Department</label><select id="department-filter" value={department} onChange={(event) => setDepartment(event.target.value)}><option value="">All departments</option>{departments.map((value) => <option key={value}>{value}</option>)}</select></div>
        <div className="filter-field"><label htmlFor="today-filter">Today</label><select id="today-filter" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="checked_in">Checked in</option><option value="present">Present</option><option value="absent">Absent</option><option value="leave">On leave</option><option value="missing_punch">Missing punch</option><option value="unscheduled_punch">Unscheduled punch</option></select></div>
        <div className="filter-count">{rows.length} employees</div>
      </div>

      <Panel>
        {loading ? <LoadingState label="Loading employees" /> : error ? <ErrorState message={error} /> : rows.length === 0 ? <EmptyState title="No employees found" message={canManage ? "Add the first employee or change the current filters." : "Change the search or filters to broaden the result."} /> : (
          <div className="table-wrap"><table className="data-table responsive-table"><thead><tr><SortableHeader column="employee" label="Employee" sort={sort} onSort={requestSort} /><SortableHeader column="code" label="Employee code" sort={sort} onSort={requestSort} /><SortableHeader column="department" label="Department" sort={sort} onSort={requestSort} /><SortableHeader column="shift" label="Shift" sort={sort} onSort={requestSort} /><SortableHeader column="fingerprint" label="Fingerprint" sort={sort} onSort={requestSort} /><SortableHeader column="today" label="Today" sort={sort} onSort={requestSort} /><SortableHeader column="lastPunch" label="Last punch" sort={sort} onSort={requestSort} /><SortableHeader column="late" label="Late this month" sort={sort} onSort={requestSort} /><SortableHeader column="overtime" label="OT this month" sort={sort} onSort={requestSort} /><th aria-label="Open" /></tr></thead><tbody>
            {rows.map((employee) => {
              const enrollment = newestEnrollment(data?.enrollments ?? [], employee.id);
              return <tr key={employee.id}>
                <td data-label="Employee" data-primary="true"><Link href={`/employees/${employee.id}`} className="cell-main"><span className="cell-avatar">{initials(employee.name)}</span><span className="cell-copy"><strong>{employee.name}</strong><small>{employee.branchName}</small></span></Link></td>
                <td data-label="Employee code" className="numeric">{employee.employeeCode}</td><td data-label="Department">{employee.departmentName}</td><td data-label="Shift">{employee.shiftName}</td>
                <td data-label="Fingerprint"><button className="enrollment-state" data-state={enrollment?.state ?? "none"} type="button" disabled={!canManage || enrollment?.state === "queued" || enrollment?.state === "capturing"} onClick={() => setEnrolling(employee)} title={enrollment?.lastError ?? "Enroll fingerprint"}><Fingerprint size={14} /><span>{enrollmentLabel(enrollment)}</span></button></td>
                <td data-label="Today"><StatusBadge status={employee.todayStatus} /></td><td data-label="Last punch" className="numeric">{employee.lastPunch ?? "—"}</td><td data-label="Late this month" className={employee.lateMinutesThisMonth > 0 ? "numeric warning-text" : "numeric muted"}>{formatMinutes(employee.lateMinutesThisMonth, true)}</td><td data-label="OT this month" className={employee.overtimeMinutesThisMonth > 0 ? "numeric positive-text" : "numeric muted"}>{formatMinutes(employee.overtimeMinutesThisMonth, true)}</td><td data-action="true"><Link className="row-link" href={`/employees/${employee.id}`} aria-label={`Open ${employee.name}`}><ArrowRight size={15} /></Link></td>
              </tr>;
            })}
          </tbody></table></div>
        )}
      </Panel>

      <MappingModal identity={mapping} employees={data?.employees ?? []} organizationId={user?.organizationId ?? ""} onClose={() => setMapping(null)} onMapped={(identityId) => { setHiddenMappings((current) => [...current, identityId]); setMapping(null); refresh(); }} />
      <CreateEmployeeModal open={creating} organizationId={user?.organizationId ?? ""} branches={data?.branches ?? []} departments={data?.departments ?? []} devices={data?.devices ?? []} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); refresh(); }} />
      <EnrollmentModal employee={enrolling} organizationId={user?.organizationId ?? ""} devices={data?.devices ?? []} onClose={() => setEnrolling(null)} onQueued={refresh} />
    </>
  );
}

function newestEnrollment(enrollments: DeviceEnrollment[], employeeId: string): DeviceEnrollment | null {
  return enrollments.filter((enrollment) => enrollment.employeeId === employeeId).sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))[0] ?? null;
}

function enrollmentLabel(enrollment: DeviceEnrollment | null): string {
  if (enrollment === null) return "Not enrolled";
  return ({ user_pending: "Syncing user", user_synced: "Ready to enroll", queued: "Enrollment queued", capturing: "Touch scanner", enrolled: "Enrolled", failed: "Enrollment failed" } as const)[enrollment.state];
}

function CreateEmployeeModal({ open, organizationId, branches, departments, devices, onClose, onCreated }: { open: boolean; organizationId: string; branches: Branch[]; departments: Department[]; devices: Device[]; onClose(): void; onCreated(): void }) {
  const [employeeCode, setEmployeeCode] = useState(""); const [name, setName] = useState(""); const [branchId, setBranchId] = useState(""); const [departmentId, setDepartmentId] = useState(""); const [deviceId, setDeviceId] = useState(""); const [hireDate, setHireDate] = useState(""); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); setSubmitting(true); setError(null); try { await createEmployee({ organizationId, employeeCode, name, branchId, departmentId: departmentId || null, ...(hireDate ? { hireDate } : {}), deviceId: deviceId || null }); setEmployeeCode(""); setName(""); setDepartmentId(""); setHireDate(""); onCreated(); } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Employee could not be created"); } finally { setSubmitting(false); } }
  return <Modal open={open} title="Add employee" description="Create the cloud identity and optionally provision the same employee code on a Hikvision terminal." onClose={onClose}><form className="modal-content" onSubmit={submit}>{error ? <ErrorState message={error} /> : null}<div className="form-grid">
    <div className="form-field"><label htmlFor="new-employee-code">Employee code</label><input id="new-employee-code" required maxLength={32} pattern="[A-Za-z0-9](?:[A-Za-z0-9._]|-){0,31}" placeholder="E001" value={employeeCode} onChange={(event) => setEmployeeCode(event.target.value)} /></div>
    <div className="form-field"><label htmlFor="new-employee-name">Full name</label><input id="new-employee-name" required maxLength={128} placeholder="Employee name" value={name} onChange={(event) => setName(event.target.value)} /></div>
    <div className="form-field"><label htmlFor="new-employee-branch">Branch</label><select id="new-employee-branch" required value={branchId} onChange={(event) => { setBranchId(event.target.value); setDeviceId(""); }}><option value="">Select branch</option>{branches.filter((branch) => branch.status === "active").map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div>
    <div className="form-field"><label htmlFor="new-employee-department">Department</label><select id="new-employee-department" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">Unassigned</option>{departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
    <div className="form-field"><label htmlFor="new-employee-device">Provision on terminal</label><select id="new-employee-device" value={deviceId} onChange={(event) => setDeviceId(event.target.value)} disabled={branchId === ""}><option value="">Cloud only</option>{devices.filter((device) => device.branchId === branchId && device.connectionStatus !== "disabled").map((device) => <option key={device.id} value={device.id}>{device.name} · {device.connectionStatus}</option>)}</select></div>
    <div className="form-field"><label htmlFor="new-employee-hire-date">Hire date</label><input id="new-employee-hire-date" type="date" value={hireDate} onChange={(event) => setHireDate(event.target.value)} /></div>
  </div><BiometricNote title="No fingerprint is collected in this form." text="Enrollment happens directly on the selected terminal after the employee is created." /><div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={submitting || branchId === ""}>{submitting ? "Creating…" : "Create employee"}</Button></div></form></Modal>;
}

function EnrollmentModal({ employee, organizationId, devices, onClose, onQueued }: { employee: Employee | null; organizationId: string; devices: Device[]; onClose(): void; onQueued(): void }) {
  const [deviceId, setDeviceId] = useState(""); const [fingerPrintId, setFingerPrintId] = useState(1); const [submitting, setSubmitting] = useState(false); const [queued, setQueued] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); if (employee === null) return; setSubmitting(true); setError(null); try { await requestFingerprintEnrollment({ organizationId, employeeId: employee.id, deviceId, fingerPrintId }); setQueued(true); onQueued(); } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Fingerprint enrollment could not be queued"); } finally { setSubmitting(false); } }
  function close() { setQueued(false); setError(null); onClose(); }
  return <Modal open={employee !== null} title="Enroll fingerprint" description={employee ? `${employee.employeeCode} · ${employee.name}` : ""} onClose={close}>{employee ? queued ? <div className="modal-content"><div className="enrollment-instruction"><span><Fingerprint size={28} /></span><div><strong>Place the employee’s finger on the terminal now</strong><p>HikBridge will create or update the terminal user, capture the selected finger, and report only status and quality to the cloud.</p></div></div><div className="form-actions"><Button onClick={close}>Done</Button></div></div> : <form className="modal-content" onSubmit={submit}>{error ? <ErrorState message={error} /> : null}<div className="form-grid"><div className="form-field form-field-full"><label htmlFor="enrollment-device">Terminal</label><select id="enrollment-device" required value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><option value="">Select terminal</option>{devices.filter((device) => device.branchId === employee.branchId && device.connectionStatus !== "disabled").map((device) => <option key={device.id} value={device.id}>{device.name} · {device.connectionStatus}</option>)}</select></div><div className="form-field form-field-full"><label htmlFor="enrollment-finger">Finger slot</label><select id="enrollment-finger" value={fingerPrintId} onChange={(event) => setFingerPrintId(Number(event.target.value))}>{Array.from({ length: 10 }, (_, index) => <option key={index + 1} value={index + 1}>Finger {index + 1}</option>)}</select></div></div><BiometricNote title="The command expires after five minutes." text="Have the employee standing at the selected terminal before starting." /><div className="form-actions"><Button type="button" variant="secondary" onClick={close}>Cancel</Button><Button type="submit" disabled={submitting || deviceId === ""}>{submitting ? "Starting…" : "Start enrollment"}</Button></div></form> : null}</Modal>;
}

function BiometricNote({ title, text }: { title: string; text: string }) { return <div className="biometric-note"><Fingerprint size={17} /><span><strong>{title}</strong><small>{text}</small></span></div>; }

function MappingModal({ identity, employees, organizationId, onClose, onMapped }: { identity: UnmappedIdentity | null; employees: Employee[]; organizationId: string; onClose(): void; onMapped(identityId: string): void }) {
  const [employeeId, setEmployeeId] = useState(""); const [reason, setReason] = useState("Confirmed against HR employee register"); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); if (identity === null) return; setSubmitting(true); setError(null); try { await mapDeviceIdentity({ organizationId, deviceId: identity.deviceId, employeeNo: identity.employeeNo, employeeId, reason }); onMapped(identity.id); } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Identity could not be mapped"); } finally { setSubmitting(false); } }
  return <Modal open={identity !== null} title="Map device identity" description="Historical raw events will be recalculated; the source evidence will not be edited." onClose={onClose}>{identity ? <form className="modal-content" onSubmit={submit}><div className="mapping-preview"><div><small>Device identity</small><strong>User {identity.employeeNo} · {identity.deviceEmployeeName}</strong><span>{identity.deviceName} · {identity.eventCount} event{identity.eventCount === 1 ? "" : "s"}</span></div><ArrowRight size={18} /><div><small>Cloud employee</small><strong>{employees.find((employee) => employee.id === employeeId)?.name ?? "Select employee"}</strong><span>{employees.find((employee) => employee.id === employeeId)?.employeeCode ?? "Not mapped"}</span></div></div>{error ? <ErrorState message={error} /> : null}<div className="form-grid"><div className="form-field form-field-full"><label htmlFor="mapping-employee">Employee</label><select id="mapping-employee" required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">Select employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeCode} · {employee.name}</option>)}</select></div><div className="form-field form-field-full"><label htmlFor="mapping-reason">Reason</label><textarea id="mapping-reason" required minLength={3} value={reason} onChange={(event) => setReason(event.target.value)} /></div></div><div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={submitting || employeeId === ""}>{submitting ? "Mapping…" : "Map and recalculate"}</Button></div></form> : null}</Modal>;
}
