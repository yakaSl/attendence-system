"use client";

import {
  Building2,
  CheckCircle2,
  Clock3,
  Database,
  KeyRound,
  LockKeyhole,
  MapPin,
  Plus,
  ShieldCheck,
  Trash2,
  UserCog,
  UsersRound,
} from "lucide-react";
import { useCallback, useMemo, useState, type FormEvent } from "react";

import { SortableHeader } from "@/components/sortable-header";
import { Button, EmptyState, ErrorState, LoadingState, Modal, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import { useData } from "@/lib/data/data-provider";
import type { Branch, Department, Device, Employee, UnmappedIdentity } from "@/lib/data/types";
import { createBranch, createDepartment, deleteBranch } from "@/lib/firebase/actions";
import { slugifyIdentifier } from "@/lib/onboarding";
import { nextSort, sortRows, type SortState } from "@/lib/sorting";
import { useAsyncData } from "@/lib/use-async-data";

interface SettingsData {
  unmapped: UnmappedIdentity[];
  branches: Branch[];
  departments: Department[];
  employees: Employee[];
  devices: Device[];
}

type DepartmentSort = "name" | "id" | "employees";
type BranchSort = "name" | "id" | "employees" | "devices" | "status";

export default function SettingsPage() {
  const { user, demo } = useAuth();
  const { repository, organization } = useData();
  const load = useCallback(async (): Promise<SettingsData> => {
    const organizationId = user?.organizationId ?? "";
    const [unmapped, branches, departments, employees, devices] = await Promise.all([
      repository.getUnmappedIdentities(organizationId),
      repository.getBranches(organizationId),
      repository.getDepartments(organizationId),
      repository.getEmployees(organizationId, new Date().toISOString().slice(0, 10)),
      repository.getDevices(organizationId),
    ]);
    return { unmapped, branches, departments, employees, devices };
  }, [repository, user?.organizationId]);
  const { data, loading, error, refresh } = useAsyncData(load);
  const [addingDepartment, setAddingDepartment] = useState(false);
  const [addingBranch, setAddingBranch] = useState(false);
  const [deletingBranch, setDeletingBranch] = useState<Branch | null>(null);
  const [departmentSort, setDepartmentSort] = useState<SortState<DepartmentSort>>({ key: "name", direction: "asc" });
  const [branchSort, setBranchSort] = useState<SortState<BranchSort>>({ key: "name", direction: "asc" });
  const canManage = user !== null && ["organizationOwner", "hrAdmin", "platformAdmin"].includes(user.role);

  const departmentRows = useMemo(() => sortRows(data?.departments ?? [], departmentSort, {
    name: (department) => department.name,
    id: (department) => department.id,
    employees: (department) => data?.employees.filter((employee) => employee.departmentId === department.id).length ?? 0,
  }), [data, departmentSort]);
  const branchRows = useMemo(() => sortRows(data?.branches ?? [], branchSort, {
    name: (branch) => branch.name,
    id: (branch) => branch.id,
    employees: (branch) => data?.employees.filter((employee) => employee.branchId === branch.id).length ?? 0,
    devices: (branch) => data?.devices.filter((device) => device.branchId === branch.id).length ?? 0,
    status: (branch) => branch.status,
  }), [branchSort, data]);

  return (
    <>
      <PageHeader eyebrow="Workspace controls" title="Settings" description="Manage organization reference data, access boundaries, and integration readiness." />
      <div className="settings-grid">
        <Panel title="Organization context" description="Authoritative tenant settings used by calculations">
          <div className="settings-list">
            <div><span className="settings-icon"><Building2 size={16} /></span><span><small>Organization</small><strong>{organization?.name ?? "Loading"}</strong></span></div>
            <div><span className="settings-icon"><Clock3 size={16} /></span><span><small>IANA timezone</small><strong>{organization?.timezone ?? "Not configured"}</strong></span></div>
            <div><span className="settings-icon"><UserCog size={16} /></span><span><small>Your role</small><strong className="capitalize">{user?.role.replace(/([A-Z])/g, " $1")}</strong></span></div>
            <div><span className="settings-icon"><Database size={16} /></span><span><small>Data source</small><strong>{demo ? "Local demonstration dataset" : "Cloud Firestore"}</strong></span></div>
          </div>
        </Panel>
        <Panel title="Integration health" description="Items administrators should resolve before payroll close">
          {loading ? <LoadingState label="Checking integration state" /> : error ? <ErrorState message={error} /> : <div className="readiness-list">
            <div><span><CheckCircle2 size={15} /><strong>Attendance calculation</strong></span><StatusBadge status="online" /></div>
            <div><span><ShieldCheck size={15} /><strong>Immutable raw event policy</strong></span><StatusBadge status="online" /></div>
            <div><span><KeyRound size={15} /><strong>Browser credential access</strong></span><span className="safe-copy">Blocked</span></div>
            <div><span><LockKeyhole size={15} /><strong>Unmapped event identities</strong></span><span className={data && data.unmapped.length > 0 ? "warning-text" : "positive-text"}>{data?.unmapped.length ?? 0} open</span></div>
          </div>}
        </Panel>
      </div>

      <div className="master-data-grid">
        <Panel
          title="Departments"
          description={`${data?.departments.length ?? 0} departments available to employee records`}
          action={canManage ? <Button variant="secondary" onClick={() => setAddingDepartment(true)}><Plus size={14} />Add department</Button> : undefined}
        >
          {loading ? <LoadingState label="Loading departments" /> : error ? <ErrorState message={error} /> : departmentRows.length === 0 ? (
            <EmptyState title="No departments" message="Add a department before organizing employee records." action={canManage ? <Button onClick={() => setAddingDepartment(true)}>Add department</Button> : undefined} />
          ) : <div className="table-wrap"><table className="data-table responsive-table"><thead><tr>
            <SortableHeader column="name" label="Department" sort={departmentSort} onSort={(key) => setDepartmentSort((current) => nextSort(current, key))} />
            <SortableHeader column="id" label="ID" sort={departmentSort} onSort={(key) => setDepartmentSort((current) => nextSort(current, key))} />
            <SortableHeader column="employees" label="Employees" sort={departmentSort} onSort={(key) => setDepartmentSort((current) => nextSort(current, key))} />
          </tr></thead><tbody>{departmentRows.map((department) => {
            const employees = data?.employees.filter((employee) => employee.departmentId === department.id).length ?? 0;
            return <tr key={department.id}><td data-label="Department" data-primary="true"><span className="master-name"><UsersRound size={15} /><strong>{department.name}</strong></span></td><td data-label="ID" className="numeric muted">{department.id}</td><td data-label="Employees" className="numeric">{employees}</td></tr>;
          })}</tbody></table></div>}
        </Panel>

        <Panel
          title="Branches"
          description="Inactive branches remain available for historical attendance"
          action={canManage ? <Button variant="secondary" onClick={() => setAddingBranch(true)}><Plus size={14} />Add branch</Button> : undefined}
        >
          {loading ? <LoadingState label="Loading branches" /> : error ? <ErrorState message={error} /> : branchRows.length === 0 ? (
            <EmptyState title="No branches" message="Add a work location before provisioning devices or employees." action={canManage ? <Button onClick={() => setAddingBranch(true)}>Add branch</Button> : undefined} />
          ) : <div className="table-wrap"><table className="data-table responsive-table"><thead><tr>
            <SortableHeader column="name" label="Branch" sort={branchSort} onSort={(key) => setBranchSort((current) => nextSort(current, key))} />
            <SortableHeader column="id" label="ID" sort={branchSort} onSort={(key) => setBranchSort((current) => nextSort(current, key))} />
            <SortableHeader column="employees" label="Employees" sort={branchSort} onSort={(key) => setBranchSort((current) => nextSort(current, key))} />
            <SortableHeader column="devices" label="Devices" sort={branchSort} onSort={(key) => setBranchSort((current) => nextSort(current, key))} />
            <SortableHeader column="status" label="Status" sort={branchSort} onSort={(key) => setBranchSort((current) => nextSort(current, key))} />
            {canManage ? <th aria-label="Actions" /> : null}
          </tr></thead><tbody>{branchRows.map((branch) => {
            const employees = data?.employees.filter((employee) => employee.branchId === branch.id).length ?? 0;
            const devices = data?.devices.filter((device) => device.branchId === branch.id).length ?? 0;
            const primary = organization?.primaryBranchId === branch.id;
            const blocked = primary || employees > 0 || devices > 0 || branch.status === "inactive";
            const reason = primary ? "Primary branch cannot be deleted" : employees > 0 ? "Move employees before deleting" : devices > 0 ? "Move or remove devices before deleting" : branch.status === "inactive" ? "Branch is already inactive" : "Delete branch";
            return <tr key={branch.id}><td data-label="Branch" data-primary="true"><span className="master-name"><MapPin size={15} /><span><strong>{branch.name}</strong>{primary ? <small>Primary</small> : null}</span></span></td><td data-label="ID" className="numeric muted">{branch.id}</td><td data-label="Employees" className="numeric">{employees}</td><td data-label="Devices" className="numeric">{devices}</td><td data-label="Status"><StatusBadge status={branch.status} /></td>{canManage ? <td data-action="true"><button className="icon-button table-action danger-icon" disabled={blocked} title={reason} onClick={() => setDeletingBranch(branch)} aria-label={`Delete ${branch.name}`}><Trash2 size={14} /></button></td> : null}</tr>;
          })}</tbody></table></div>}
        </Panel>
      </div>

      <Panel title="Role capabilities" description="Firestore rules remain the enforcement boundary; hidden controls are only a usability layer.">
        <div className="table-wrap"><table className="data-table responsive-table role-table"><thead><tr><th>Role</th><th>Read attendance</th><th>Manage employees</th><th>Manage shifts</th><th>Correct attendance</th><th>Provision devices</th><th>Manage members</th></tr></thead><tbody>
          <RoleRow role="Organization owner" values={[true, true, true, true, true, true]} />
          <RoleRow role="HR administrator" values={[true, true, true, true, true, false]} />
          <RoleRow role="Manager" values={[true, false, false, false, false, false]} />
          <RoleRow role="Viewer" values={[true, false, false, false, false, false]} />
        </tbody></table></div>
      </Panel>
      <div className="security-principles">
        <div><ShieldCheck size={18} /><span><strong>Tenant-scoped paths</strong><small>Operational data lives below the selected organization.</small></span></div>
        <div><Database size={18} /><span><strong>Immutable evidence</strong><small>Device events cannot be edited by any browser role.</small></span></div>
        <div><KeyRound size={18} /><span><strong>Server-only secrets</strong><small>Bridge keys live in Secret Manager and are shown only at creation or rotation.</small></span></div>
      </div>

      <DepartmentModal open={addingDepartment} organizationId={user?.organizationId ?? ""} onClose={() => setAddingDepartment(false)} onCreated={() => { setAddingDepartment(false); refresh(); }} />
      <BranchModal open={addingBranch} organizationId={user?.organizationId ?? ""} onClose={() => setAddingBranch(false)} onCreated={() => { setAddingBranch(false); refresh(); }} />
      <DeleteBranchModal branch={deletingBranch} organizationId={user?.organizationId ?? ""} onClose={() => setDeletingBranch(null)} onDeleted={() => { setDeletingBranch(null); refresh(); }} />
    </>
  );
}

function DepartmentModal({ open, organizationId, onClose, onCreated }: { open: boolean; organizationId: string; onClose(): void; onCreated(): void }) {
  const [name, setName] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [identifierEdited, setIdentifierEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function updateName(value: string) { setName(value); if (!identifierEdited) setDepartmentId(slugifyIdentifier(value)); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setSubmitting(true); setError(null);
    try { await createDepartment({ organizationId, departmentId, name }); setName(""); setDepartmentId(""); setIdentifierEdited(false); onCreated(); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Department could not be created"); }
    finally { setSubmitting(false); }
  }
  return <Modal open={open} title="Add department" description="Create a department that can be assigned to employee records." onClose={onClose}><form className="modal-content" onSubmit={submit}>{error ? <ErrorState message={error} /> : null}<div className="form-grid"><div className="form-field"><label htmlFor="department-name">Department name</label><input id="department-name" required minLength={2} maxLength={100} autoFocus placeholder="Operations" value={name} onChange={(event) => updateName(event.target.value)} /></div><div className="form-field"><label htmlFor="department-id">Department ID</label><input id="department-id" required minLength={2} maxLength={63} pattern="[a-z0-9](?:[a-z0-9]|-){1,62}" placeholder="operations" value={departmentId} onChange={(event) => { setIdentifierEdited(true); setDepartmentId(event.target.value.toLowerCase()); }} /><small>Lowercase letters, numbers, and hyphens. This cannot be changed later.</small></div></div><div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={submitting || organizationId === ""}>{submitting ? "Creating…" : "Create department"}</Button></div></form></Modal>;
}

function BranchModal({ open, organizationId, onClose, onCreated }: { open: boolean; organizationId: string; onClose(): void; onCreated(): void }) {
  const [name, setName] = useState("");
  const [branchId, setBranchId] = useState("");
  const [identifierEdited, setIdentifierEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function updateName(value: string) { setName(value); if (!identifierEdited) setBranchId(slugifyIdentifier(value)); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setSubmitting(true); setError(null);
    try { await createBranch({ organizationId, branchId, name }); setName(""); setBranchId(""); setIdentifierEdited(false); onCreated(); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Branch could not be created"); }
    finally { setSubmitting(false); }
  }
  return <Modal open={open} title="Add branch" description="Create a work location for employees and bridge devices." onClose={onClose}><form className="modal-content" onSubmit={submit}>{error ? <ErrorState message={error} /> : null}<div className="form-grid"><div className="form-field"><label htmlFor="settings-branch-name">Branch name</label><input id="settings-branch-name" required minLength={2} maxLength={100} autoFocus placeholder="Kandy Office" value={name} onChange={(event) => updateName(event.target.value)} /></div><div className="form-field"><label htmlFor="settings-branch-id">Branch ID</label><input id="settings-branch-id" required minLength={2} maxLength={63} pattern="[a-z0-9](?:[a-z0-9]|-){1,62}" placeholder="kandy-office" value={branchId} onChange={(event) => { setIdentifierEdited(true); setBranchId(event.target.value.toLowerCase()); }} /><small>Lowercase letters, numbers, and hyphens. This cannot be changed later.</small></div></div><div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={submitting || organizationId === ""}>{submitting ? "Creating…" : "Create branch"}</Button></div></form></Modal>;
}

function DeleteBranchModal({ branch, organizationId, onClose, onDeleted }: { branch: Branch | null; organizationId: string; onClose(): void; onDeleted(): void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    if (branch === null) return;
    setSubmitting(true); setError(null);
    try { await deleteBranch({ organizationId, branchId: branch.id }); onDeleted(); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Branch could not be deleted"); }
    finally { setSubmitting(false); }
  }
  return <Modal open={branch !== null} title="Delete branch" description="This removes the branch from active selectors while preserving historical attendance." onClose={onClose}>{branch ? <div className="modal-content">{error ? <ErrorState message={error} /> : null}<div className="delete-summary"><Trash2 size={18} /><span><strong>{branch.name}</strong><small>{branch.id} · Existing historical records will retain this branch.</small></span></div><p className="modal-note">Deletion is blocked if employees, devices, or member access still reference this branch.</p><div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="button" variant="danger" disabled={submitting} onClick={remove}>{submitting ? "Deleting…" : "Delete branch"}</Button></div></div> : null}</Modal>;
}

function RoleRow({ role, values }: { role: string; values: boolean[] }) {
  const labels = ["Read attendance", "Manage employees", "Manage shifts", "Correct attendance", "Provision devices", "Manage members"];
  return <tr><td data-label="Role" data-primary="true"><strong>{role}</strong></td>{values.map((value, index) => <td data-label={labels[index]} key={index}>{value ? <CheckCircle2 className="permission-yes" size={15} aria-label="Allowed" /> : <span className="permission-no" aria-label="Not allowed">—</span>}</td>)}</tr>;
}
