"use client";

import { Check, Copy, KeyRound, Plus, Power, RotateCw, Wifi, WifiOff } from "lucide-react";
import { useCallback, useMemo, useState, type FormEvent } from "react";

import { Button, EmptyState, ErrorState, LoadingState, Modal, PageHeader, Panel, RoleGate, StatusBadge } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import { useData } from "@/lib/data/data-provider";
import type { Device, Employee } from "@/lib/data/types";
import { provisionDevice, rotateDeviceCredential, setDeviceEnabled } from "@/lib/firebase/actions";
import { relativeTime, todayKey } from "@/lib/format";
import { useAsyncData } from "@/lib/use-async-data";

interface DeviceData { devices: Device[]; employees: Employee[] }

export default function DevicesPage() {
  const { user } = useAuth();
  const { repository, organization } = useData();
  const load = useCallback(async (): Promise<DeviceData> => {
    const organizationId = user?.organizationId ?? "";
    const [devices, employees] = await Promise.all([repository.getDevices(organizationId), repository.getEmployees(organizationId, todayKey(organization?.timezone))]);
    return { devices, employees };
  }, [organization?.timezone, repository, user?.organizationId]);
  const { data, loading, error, refresh } = useAsyncData(load);
  const branches = useMemo(() => {
    const map = new Map((data?.employees ?? []).filter((employee) => employee.branchId).map((employee) => [employee.branchId as string, employee.branchName]));
    return [...map].sort((left, right) => left[1].localeCompare(right[1]));
  }, [data]);
  const [provisioning, setProvisioning] = useState(false);
  const [credential, setCredential] = useState<{ deviceId: string; bridgeKey: string; graceMinutes?: number } | null>(null);
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
      <PageHeader eyebrow="Bridge operations" title="Devices" description="Monitor Hikvision terminal connectivity and manage bridge enrollment without exposing stored secrets." actions={canManage ? <Button onClick={() => setProvisioning(true)}><Plus size={14} />Provision device</Button> : undefined} />
      <div className="device-summary-line"><span><i data-status="online" />{data?.devices.filter((device) => device.connectionStatus === "online").length ?? 0} online</span><span><i data-status="offline" />{data?.devices.filter((device) => device.connectionStatus === "offline").length ?? 0} offline</span><span><i data-status="disabled" />{data?.devices.filter((device) => device.connectionStatus === "disabled").length ?? 0} disabled</span></div>
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
            {canManage ? <div className="device-actions"><button className="icon-button" disabled={busyDevice === device.id} onClick={() => rotate(device)} aria-label={`Rotate ${device.name} credential`}><RotateCw size={14} /></button><button className="icon-button" disabled={busyDevice === device.id} onClick={() => toggle(device)} aria-label={`${device.connectionStatus === "disabled" ? "Enable" : "Disable"} ${device.name}`}><Power size={14} /></button></div> : null}
          </article>)}</div>
        )}
      </Panel>
      <RoleGate role={user?.role ?? "viewer"} allowed={["organizationOwner", "hrAdmin"]}>
        <ProvisionModal open={provisioning} organizationId={user?.organizationId ?? ""} branches={branches} onClose={() => setProvisioning(false)} onProvisioned={(result) => { setProvisioning(false); setCredential(result); refresh(); }} />
      </RoleGate>
      <CredentialModal credential={credential} onClose={() => setCredential(null)} />
    </>
  );
}

function ProvisionModal({ open, organizationId, branches, onClose, onProvisioned }: { open: boolean; organizationId: string; branches: [string, string][]; onClose(): void; onProvisioned(result: { deviceId: string; bridgeKey: string }): void }) {
  const [name, setName] = useState(""); const [deviceId, setDeviceId] = useState(""); const [branchId, setBranchId] = useState(""); const [description, setDescription] = useState(""); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); setSubmitting(true); setError(null); try { const result = await provisionDevice({ organizationId, branchId, localDeviceId: deviceId, name, deviceType: "hikvision_ds_k1a8503ef", ...(description ? { description } : {}) }); onProvisioned({ deviceId: result.deviceId, bridgeKey: result.bridgeKey }); } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Device could not be provisioned"); } finally { setSubmitting(false); } }
  return <Modal open={open} title="Provision HikBridge" description="A 256-bit bridge credential will be shown exactly once after registration." onClose={onClose}><form className="modal-content" onSubmit={submit}>{error ? <ErrorState message={error} /> : null}<div className="form-grid"><div className="form-field"><label htmlFor="device-id">Bridge device ID</label><input id="device-id" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="office-main-01" value={deviceId} onChange={(event) => setDeviceId(event.target.value)} /></div><div className="form-field"><label htmlFor="device-name">Display name</label><input id="device-name" required placeholder="Main Entrance" value={name} onChange={(event) => setName(event.target.value)} /></div><div className="form-field"><label htmlFor="device-branch">Branch</label><select id="device-branch" required value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">Select branch</option>{branches.map(([id, branchName]) => <option key={id} value={id}>{branchName}</option>)}</select></div><div className="form-field"><label htmlFor="device-model">Device model</label><input id="device-model" value="Hikvision DS-K1A8503EF" disabled /></div><div className="form-field form-field-full"><label htmlFor="device-description">Description</label><textarea id="device-description" maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></div></div><div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={submitting}>{submitting ? "Provisioning…" : "Provision and create key"}</Button></div></form></Modal>;
}

function CredentialModal({ credential, onClose }: { credential: { deviceId: string; bridgeKey: string; graceMinutes?: number } | null; onClose(): void }) {
  const [copied, setCopied] = useState(false);
  async function copy() { if (!credential) return; await navigator.clipboard.writeText(credential.bridgeKey); setCopied(true); }
  return <Modal open={credential !== null} title="Store this bridge credential now" description="It will not be available from the dashboard after this window closes." onClose={onClose}>{credential ? <div className="modal-content"><div className="credential-warning"><KeyRound size={18} /><span><strong>{credential.deviceId}</strong><small>{credential.graceMinutes ? `Previous credential remains valid for ${credential.graceMinutes} minutes.` : "New device registration."}</small></span></div><label className="credential-box"><span>Bridge key</span><code>{credential.bridgeKey}</code><button type="button" onClick={copy}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "Copied" : "Copy"}</button></label><ol className="credential-steps"><li>Place the key in HikBridge `cloud.bridgeKey` configuration.</li><li>Confirm the deployed HTTPS ingestion endpoint.</li><li>Run `hikbridge.exe test-cloud`, then restart the service.</li></ol><div className="form-actions"><Button onClick={onClose}>I stored the key</Button></div></div> : null}</Modal>;
}
