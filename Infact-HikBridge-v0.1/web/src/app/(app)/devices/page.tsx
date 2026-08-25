"use client";

import { Check, Copy, Download, GitMerge, KeyRound, MapPin, MonitorDown, Plus, Power, RotateCw, ShieldCheck, Trash2, Wifi, WifiOff } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";

import { Button, EmptyState, ErrorState, LoadingState, Modal, PageHeader, Panel, RoleGate, StatusBadge } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import { useData } from "@/lib/data/data-provider";
import type { Branch, Device } from "@/lib/data/types";
import { createBranch, mergeDeviceEnrollmentData, provisionDevice, removeDevice, rotateDeviceCredential, setDeviceEnabled, type MergeDeviceEnrollmentDataResult } from "@/lib/firebase/actions";
import { relativeTime } from "@/lib/format";
import { slugifyIdentifier } from "@/lib/onboarding";
import { useAsyncData } from "@/lib/use-async-data";

interface DeviceData { devices: Device[]; branches: Branch[] }

const installerDownloadPath = "/downloads/hikbridge";

export default function DevicesPage() {
  const { user } = useAuth();
  const { repository } = useData();
  const load = useCallback(async (): Promise<DeviceData> => {
    const organizationId = user?.organizationId ?? "";
    const [devices, branches] = await Promise.all([repository.getDevices(organizationId), repository.getBranches(organizationId)]);
    return { devices, branches };
  }, [repository, user?.organizationId]);
  const { data, loading, error, refresh } = useAsyncData(load);
  const branches = (data?.branches ?? []).filter((branch) => branch.status === "active");
  const [addingBranch, setAddingBranch] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [credential, setCredential] = useState<{ deviceId: string; bridgeKey: string; graceMinutes?: number } | null>(null);
  const [mergingIntoDevice, setMergingIntoDevice] = useState<Device | null>(null);
  const [removingDevice, setRemovingDevice] = useState<Device | null>(null);
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const canManage = user !== null && ["organizationOwner", "hrAdmin", "platformAdmin"].includes(user.role);

  async function rotate(device: Device) {
    if (!window.confirm(`Rotate the credential for ${device.name}? The old key will remain valid for 15 minutes.`)) return;
    setBusyDevice(device.id);
    try {
      const result = await rotateDeviceCredential({ deviceId: device.id });
      setCredential({ deviceId: device.id, bridgeKey: result.bridgeKey, graceMinutes: result.previousCredentialGraceMinutes });
    } finally { setBusyDevice(null); }
  }

  async function toggle(device: Device) {
    setBusyDevice(device.id);
    try { await setDeviceEnabled({ deviceId: device.id, enabled: device.connectionStatus === "disabled" }); refresh(); }
    finally { setBusyDevice(null); }
  }

  return (
    <>
      <PageHeader
        eyebrow="Bridge operations"
        title="Devices"
        description="Monitor Hikvision terminal connectivity and manage bridge enrollment without exposing stored secrets."
        actions={canManage ? <><Button variant="secondary" onClick={() => setAddingBranch(true)}><MapPin size={14} />Add branch</Button><Button onClick={() => setProvisioning(true)}><Plus size={14} />Provision device</Button></> : undefined}
      />
      <section className="bridge-download-strip" aria-labelledby="bridge-download-title">
        <div className="bridge-download-copy">
          <span className="bridge-download-icon"><MonitorDown size={22} aria-hidden /></span>
          <div>
            <p className="eyebrow">Windows bridge</p>
            <h2 id="bridge-download-title">Install HikBridge on the terminal PC</h2>
            <p>Connect the Hikvision terminal to this workspace and keep attendance syncing automatically after Windows restarts.</p>
          </div>
        </div>
        <div className="bridge-download-actions">
          <span><ShieldCheck size={14} aria-hidden />Signed Windows installer</span>
          <a className="button button-primary" href={installerDownloadPath} target="_blank" rel="noreferrer"><Download size={15} aria-hidden />Download HikBridge</a>
        </div>
      </section>
      <div className="device-summary-line"><span><i data-status="online" />{data?.devices.filter((device) => device.connectionStatus === "online").length ?? 0} online</span><span><i data-status="offline" />{data?.devices.filter((device) => device.connectionStatus === "offline").length ?? 0} offline</span><span><i data-status="disabled" />{data?.devices.filter((device) => device.connectionStatus === "disabled").length ?? 0} disabled</span><span><MapPin size={11} />{branches.length} {branches.length === 1 ? "branch" : "branches"}</span></div>
      <Panel title="Registered bridges" description="Heartbeat data comes from authenticated ingestion requests">
        {loading ? <LoadingState label="Loading devices" /> : error ? <ErrorState message={error} /> : !data || data.devices.length === 0 ? <EmptyState title="No bridges registered" message="Provision a bridge and install its one-time credential on the customer PC." /> : (
          <div className="device-list">{data.devices.map((device) => <article className="device-row" key={device.id}>
            <span className="device-hero-icon">{device.connectionStatus === "online" ? <Wifi size={19} /> : <WifiOff size={19} />}</span>
            <div className="device-identity"><strong>{device.name}</strong><small>{device.model} · {device.id}</small></div>
            <div className="device-detail"><small>Branch</small><strong>{device.branchName}</strong></div>
            <div className="device-detail"><small>Last seen</small><strong>{relativeTime(device.lastSeenAt)}</strong></div>
            <div className="device-detail"><small>Last punch</small><strong>{relativeTime(device.lastEventAt)}</strong></div>
            <div className="device-detail"><small>Bridge</small><strong>{device.bridgeVersion ?? "Unknown"}</strong></div>
            <div className="device-detail"><small>Pending local</small><strong>{device.pendingLocalEvents ?? "Not reported"}</strong></div>
            <StatusBadge status={device.connectionStatus} />
            {canManage ? <div className="device-actions"><button className="icon-button" disabled={busyDevice === device.id} onClick={() => rotate(device)} aria-label={`Rotate ${device.name} credential`}><RotateCw size={14} /></button><button className="icon-button" disabled={busyDevice === device.id} onClick={() => toggle(device)} aria-label={`${device.connectionStatus === "disabled" ? "Enable" : "Disable"} ${device.name}`}><Power size={14} /></button>{(data?.devices.length ?? 0) > 1 ? <button className="icon-button" disabled={busyDevice === device.id} onClick={() => setMergingIntoDevice(device)} aria-label={`Merge duplicate enrollment data into ${device.name}`}><GitMerge size={14} /></button> : null}<button className="icon-button danger-icon" disabled={busyDevice === device.id} onClick={() => setRemovingDevice(device)} aria-label={`Remove ${device.name}`}><Trash2 size={14} /></button></div> : null}
          </article>)}</div>
        )}
      </Panel>
      <RoleGate role={user?.role ?? "viewer"} allowed={["organizationOwner", "hrAdmin"]}>
        <BranchModal open={addingBranch} organizationId={user?.organizationId ?? ""} onClose={() => setAddingBranch(false)} onCreated={() => { setAddingBranch(false); refresh(); }} />
        <ProvisionModal open={provisioning} organizationId={user?.organizationId ?? ""} branches={branches} onClose={() => setProvisioning(false)} onProvisioned={(result) => { setProvisioning(false); setCredential(result); refresh(); }} />
      </RoleGate>
      <CredentialModal credential={credential} onClose={() => setCredential(null)} />
      {mergingIntoDevice ? <MergeDeviceModal target={mergingIntoDevice} devices={data?.devices ?? []} onClose={() => setMergingIntoDevice(null)} /> : null}
      {removingDevice ? <RemoveDeviceModal device={removingDevice} onClose={() => setRemovingDevice(null)} onRemoved={() => { setRemovingDevice(null); refresh(); }} /> : null}
    </>
  );
}

function BranchModal({ open, organizationId, onClose, onCreated }: { open: boolean; organizationId: string; onClose(): void; onCreated(): void }) {
  const [name, setName] = useState("");
  const [branchId, setBranchId] = useState("");
  const [identifierEdited, setIdentifierEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createBranch({ organizationId, branchId, name });
      setName("");
      setBranchId("");
      setIdentifierEdited(false);
      onCreated();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Branch could not be created");
    } finally {
      setSubmitting(false);
    }
  }

  function updateName(value: string) {
    setName(value);
    if (!identifierEdited) setBranchId(slugifyIdentifier(value));
  }

  return <Modal open={open} title="Add branch" description="Create a work location that can be assigned to devices and employees." onClose={onClose}><form className="modal-content" onSubmit={submit}>{error ? <ErrorState message={error} /> : null}<div className="form-grid"><div className="form-field"><label htmlFor="branch-name">Branch name</label><input id="branch-name" required minLength={2} maxLength={100} autoFocus placeholder="Kandy Office" value={name} onChange={(event) => updateName(event.target.value)} /></div><div className="form-field"><label htmlFor="branch-id">Branch ID</label><input id="branch-id" required minLength={2} maxLength={63} pattern="[a-z0-9](?:[a-z0-9]|-){1,62}" placeholder="kandy-office" value={branchId} onChange={(event) => { setIdentifierEdited(true); setBranchId(event.target.value.toLowerCase()); }} /><small>Lowercase letters, numbers, and hyphens. This cannot be changed later.</small></div></div><div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={submitting || organizationId === ""}>{submitting ? "Creating…" : "Create branch"}</Button></div></form></Modal>;
}

function ProvisionModal({ open, organizationId, branches, onClose, onProvisioned }: { open: boolean; organizationId: string; branches: Branch[]; onClose(): void; onProvisioned(result: { deviceId: string; bridgeKey: string }): void }) {
  const [name, setName] = useState(""); const [deviceId, setDeviceId] = useState(""); const [branchId, setBranchId] = useState(""); const [description, setDescription] = useState(""); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); setSubmitting(true); setError(null); try { const result = await provisionDevice({ organizationId, branchId, localDeviceId: deviceId, name, deviceType: "hikvision_ds_k1a8503ef", ...(description ? { description } : {}) }); onProvisioned({ deviceId: result.deviceId, bridgeKey: result.bridgeKey }); } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Device could not be provisioned"); } finally { setSubmitting(false); } }
  return <Modal open={open} title="Provision HikBridge" description="A 256-bit bridge credential will be shown exactly once after registration." onClose={onClose}><form className="modal-content" onSubmit={submit}>{error ? <ErrorState message={error} /> : null}{branches.length === 0 ? <EmptyState title="No active branches" message="Add a branch before provisioning a bridge." /> : null}<div className="form-grid"><div className="form-field"><label htmlFor="device-id">Bridge device ID</label><input id="device-id" required pattern="[A-Za-z0-9](?:[A-Za-z0-9._]|-){0,63}" placeholder="office-main-01" value={deviceId} onChange={(event) => setDeviceId(event.target.value)} /></div><div className="form-field"><label htmlFor="device-name">Display name</label><input id="device-name" required placeholder="Main Entrance" value={name} onChange={(event) => setName(event.target.value)} /></div><div className="form-field"><label htmlFor="device-branch">Branch</label><select id="device-branch" required disabled={branches.length === 0} value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">Select branch</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div><div className="form-field"><label htmlFor="device-model">Device model</label><input id="device-model" value="Hikvision DS-K1A8503EF" disabled /></div><div className="form-field form-field-full"><label htmlFor="device-description">Description</label><textarea id="device-description" maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></div></div><div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={submitting || branches.length === 0}>{submitting ? "Provisioning…" : "Provision and create key"}</Button></div></form></Modal>;
}

function CredentialModal({ credential, onClose }: { credential: { deviceId: string; bridgeKey: string; graceMinutes?: number } | null; onClose(): void }) {
  const [copied, setCopied] = useState(false);
  async function copy() { if (!credential) return; await navigator.clipboard.writeText(credential.bridgeKey); setCopied(true); }
  return <Modal open={credential !== null} title="Store this bridge credential now" description="It will not be available from the dashboard after this window closes." onClose={onClose}>{credential ? <div className="modal-content"><div className="credential-warning"><KeyRound size={18} /><span><strong>{credential.deviceId}</strong><small>{credential.graceMinutes ? `Previous credential remains valid for ${credential.graceMinutes} minutes.` : "New device registration."}</small></span></div><label className="credential-box"><span>Bridge key</span><code>{credential.bridgeKey}</code><button type="button" onClick={copy}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "Copied" : "Copy"}</button></label><ol className="credential-steps"><li>Download and install HikBridge on a Windows PC connected to the terminal.</li><li>Open Manage HikBridge and enter this device ID and bridge key.</li><li>Test both connections, then select Save &amp; start service.</li></ol><div className="form-actions form-actions-split"><a className="button button-secondary" href={installerDownloadPath} target="_blank" rel="noreferrer"><Download size={14} aria-hidden />Download installer</a><Button onClick={onClose}>I stored the key</Button></div></div> : null}</Modal>;
}

function MergeDeviceModal({ target, devices, onClose }: { target: Device; devices: Device[]; onClose(): void }) {
  const candidates = devices.filter((device) => device.id !== target.id && device.branchId === target.branchId);
  const [sourceDeviceId, setSourceDeviceId] = useState(candidates[0]?.id ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MergeDeviceEnrollmentDataResult | null>(null);

  async function merge() {
    if (sourceDeviceId === "" || !confirmed) return;
    setSubmitting(true);
    setError(null);
    try {
      setResult(await mergeDeviceEnrollmentData({
        sourceDeviceId,
        targetDeviceId: target.id,
        confirmedSamePhysicalDevice: true,
      }));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Enrollment data could not be merged");
    } finally {
      setSubmitting(false);
    }
  }

  return <Modal open title="Merge duplicate device data" description={`Keep ${target.name} (${target.id}) and copy cloud enrollment data into it.`} onClose={submitting ? () => undefined : onClose}><div className="modal-content">{error ? <ErrorState message={error} /> : null}{result ? <><div className="credential-warning"><Check size={18} /><span><strong>Merge completed</strong><small>{result.mappedIdentities} employee mappings and {result.enrollmentRecords} enrollment records are now attached to {target.id}.</small></span></div><p className="modal-note">Run only the retained installation code and verify several punches. The source registration still exists and can be removed after verification.</p><div className="form-actions"><Button type="button" onClick={onClose}>Done</Button></div></> : candidates.length === 0 ? <EmptyState title="No same-branch duplicate" message="Only another registration in the same branch can be merged into this device." /> : <><div className="form-field"><label htmlFor="merge-source-device">Duplicate installation code to copy from</label><select id="merge-source-device" value={sourceDeviceId} onChange={(event) => setSourceDeviceId(event.target.value)}>{candidates.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.id}</option>)}</select></div><label className="platform-checkbox"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I confirm both installation codes connect to the same physical Hikvision terminal.</span></label><p className="modal-note">This copies employee-number mappings and enrollment status only. Fingerprint templates remain inside the terminal, and the source registration is not changed.</p><div className="form-actions"><Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>Cancel</Button><Button type="button" disabled={submitting || sourceDeviceId === "" || !confirmed} onClick={merge}>{submitting ? "Merging…" : "Merge enrollment data"}</Button></div></>}</div></Modal>;
}

function RemoveDeviceModal({ device, onClose, onRemoved }: { device: Device; onClose(): void; onRemoved(): void }) {
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (confirmation !== device.id) return;
    setSubmitting(true);
    setError(null);
    try {
      await removeDevice({ deviceId: device.id });
      onRemoved();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Device could not be removed");
    } finally {
      setSubmitting(false);
    }
  }

  return <Modal open title="Remove device permanently" description="The bridge registration will be revoked and removed. Historical attendance is preserved." onClose={submitting ? () => undefined : onClose}><div className="modal-content">{error ? <ErrorState message={error} /> : null}<div className="delete-summary"><Trash2 size={18} /><span><strong>{device.name}</strong><small>{device.id} · {device.branchName}</small></span></div><p className="modal-note">Stop HikBridge on the client PC first. Removal deletes the device, credential, queued commands, identity mappings, and enrollment state. This cannot be undone.</p><div className="form-field"><label htmlFor="remove-device-confirmation">Type <strong>{device.id}</strong> to confirm</label><input id="remove-device-confirmation" autoFocus autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div><div className="form-actions"><Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>Cancel</Button><Button type="button" variant="danger" disabled={submitting || confirmation !== device.id} onClick={remove}>{submitting ? "Removing…" : "Remove device"}</Button></div></div></Modal>;
}
