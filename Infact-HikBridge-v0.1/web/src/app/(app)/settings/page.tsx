"use client";

import { Building2, CheckCircle2, Clock3, Database, KeyRound, LockKeyhole, ShieldCheck, UserCog } from "lucide-react";
import { useCallback } from "react";

import { ErrorState, LoadingState, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import { useData } from "@/lib/data/data-provider";
import { useAsyncData } from "@/lib/use-async-data";

export default function SettingsPage() {
  const { user, demo } = useAuth();
  const { repository, organization } = useData();
  const load = useCallback(() => repository.getUnmappedIdentities(user?.organizationId ?? ""), [repository, user?.organizationId]);
  const { data: unmapped, loading, error } = useAsyncData(load);

  return (
    <>
      <PageHeader eyebrow="Workspace controls" title="Settings" description="Review tenant context, role access, calculation policy boundaries, and integration readiness." />
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
            <div><span><LockKeyhole size={15} /><strong>Unmapped event identities</strong></span><span className={unmapped && unmapped.length > 0 ? "warning-text" : "positive-text"}>{unmapped?.length ?? 0} open</span></div>
          </div>}
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
    </>
  );
}

function RoleRow({ role, values }: { role: string; values: boolean[] }) {
  const labels = ["Read attendance", "Manage employees", "Manage shifts", "Correct attendance", "Provision devices", "Manage members"];
  return <tr><td data-label="Role" data-primary="true"><strong>{role}</strong></td>{values.map((value, index) => <td data-label={labels[index]} key={index}>{value ? <CheckCircle2 className="permission-yes" size={15} aria-label="Allowed" /> : <span className="permission-no" aria-label="Not allowed">—</span>}</td>)}</tr>;
}
