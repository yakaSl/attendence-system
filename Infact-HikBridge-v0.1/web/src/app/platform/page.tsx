"use client";

import { Check, LoaderCircle, Pause, Play, RefreshCw, Search, ShieldCheck, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { AccountGuard } from "@/components/account-guard";
import { Button, ErrorState, StatusBadge } from "@/components/ui";
import { billingCycles, planIds, saasPlans, type BillingCycle, type PlanId } from "@/lib/billing/catalog";
import {
  activateManualSubscription,
  configureBillingProduct,
  listPlatformSubscriptions,
  setSubscriptionStatus,
  type PlatformSubscriptionRow,
} from "@/lib/firebase/actions";

function message(error: unknown): string {
  return error instanceof Error ? error.message.replace(/FirebaseError:\s*/i, "") : "The platform action failed.";
}

export default function PlatformPage() {
  const [rows, setRows] = useState<PlatformSubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [product, setProduct] = useState({ planId: "silver" as PlanId, billingCycle: "monthly" as BillingCycle, dodoProductId: "", enabled: true });
  const [manual, setManual] = useState({ organizationId: "", planId: "silver" as PlanId, billingCycle: "monthly" as BillingCycle, endsAt: "", reason: "Manual commercial agreement" });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listPlatformSubscriptions();
      setRows(result.subscriptions.sort((left, right) => left.organizationName.localeCompare(right.organizationName)));
    } catch (loadError) {
      setError(message(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query.length === 0 ? rows : rows.filter((row) => `${row.organizationName} ${row.organizationId} ${row.planName}`.toLowerCase().includes(query));
  }, [rows, search]);

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      await configureBillingProduct(product);
      setNotice(`${product.planId} ${product.billingCycle} checkout configuration saved.`);
      setProduct((current) => ({ ...current, dodoProductId: "" }));
    } catch (saveError) { setError(message(saveError)); } finally { setBusy(false); }
  }

  async function activateManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      await activateManualSubscription({ ...manual, endsAt: manual.endsAt ? new Date(`${manual.endsAt}T23:59:59+05:30`).toISOString() : null });
      setNotice(`Manual ${manual.planId} access activated for ${manual.organizationId}.`);
      await refresh();
    } catch (saveError) { setError(message(saveError)); } finally { setBusy(false); }
  }

  async function changeStatus(row: PlatformSubscriptionRow, action: "pause" | "resume" | "cancel") {
    const reason = window.prompt(`Reason to ${action} ${row.organizationName}:`);
    if (reason === null || reason.trim().length < 5) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await setSubscriptionStatus({ organizationId: row.organizationId, action, reason });
      setNotice(`${row.organizationName} was ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"}.`);
      await refresh();
    } catch (actionError) { setError(message(actionError)); } finally { setBusy(false); }
  }

  return (
    <AccountGuard platformAdmin>
      <main className="platform-page">
        <header className="platform-header"><div><p className="eyebrow">Platform owner</p><h1>Subscriptions and package operations</h1><p>Provider identifiers stay server-only. Every manual grant and status action creates an audit record.</p></div><button type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={15} />Refresh</button></header>
        {error ? <ErrorState message={error} /> : null}
        {notice ? <div className="platform-notice"><Check size={16} />{notice}</div> : null}
        <section className="platform-metrics">
          <p><span>Total subscribers</span><strong>{rows.length}</strong></p>
          <p><span>Active access</span><strong>{rows.filter((row) => row.accessStatus === "active").length}</strong></p>
          <p><span>Dodo managed</span><strong>{rows.filter((row) => row.source === "dodo").length}</strong></p>
          <p><span>Manual terms</span><strong>{rows.filter((row) => row.source === "manual").length}</strong></p>
        </section>
        <div className="platform-workbench">
          <section className="platform-subscribers">
            <div className="platform-section-heading"><div><h2>Subscribers</h2><p>Up to 250 organization subscriptions.</p></div><label><Search size={14} /><input aria-label="Search subscribers" placeholder="Search organization or plan" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
            <div className="table-wrap"><table className="data-table"><thead><tr><th>Organization</th><th>Package</th><th>Billing</th><th>Source</th><th>Access</th><th>Actions</th></tr></thead><tbody>
              {filtered.map((row) => <tr key={row.organizationId}><td><div className="cell-copy"><strong>{row.organizationName}</strong><small>{row.organizationId}</small></div></td><td>{row.planName ?? "—"}</td><td><div className="cell-copy"><strong>{row.billingCycle ?? "—"}</strong><small>{row.billingStatus ?? "unknown"}</small></div></td><td>{row.source ?? "—"}</td><td><StatusBadge status={row.accessStatus} /></td><td><div className="platform-row-actions">{row.accessStatus === "active" ? <button title="Pause" type="button" disabled={busy} onClick={() => void changeStatus(row, "pause")}><Pause size={14} /></button> : row.billingStatus !== "cancelled" ? <button title="Resume" type="button" disabled={busy} onClick={() => void changeStatus(row, "resume")}><Play size={14} /></button> : null}{row.billingStatus !== "cancelled" ? <button title="Cancel" type="button" disabled={busy} onClick={() => void changeStatus(row, "cancel")}><XCircle size={14} /></button> : null}</div></td></tr>)}
              {!loading && filtered.length === 0 ? <tr><td colSpan={6} className="platform-empty-row">No matching subscriptions.</td></tr> : null}
            </tbody></table></div>
          </section>
          <aside className="platform-controls">
            <form onSubmit={saveProduct}><div><p className="eyebrow">Dodo product map</p><h2>Enable a checkout cycle</h2><p>Create each recurring product in Dodo, then map its ID here.</p></div><label>Package<select value={product.planId} onChange={(event) => setProduct((current) => ({ ...current, planId: event.target.value as PlanId }))}>{planIds.map((id) => <option key={id} value={id}>{saasPlans.find((plan) => plan.id === id)?.name}</option>)}</select></label><label>Billing cycle<select value={product.billingCycle} onChange={(event) => setProduct((current) => ({ ...current, billingCycle: event.target.value as BillingCycle }))}>{billingCycles.map((cycle) => <option key={cycle}>{cycle}</option>)}</select></label><label>Dodo product ID<input required value={product.dodoProductId} onChange={(event) => setProduct((current) => ({ ...current, dodoProductId: event.target.value }))} placeholder="pdt_..." /></label><label className="platform-checkbox"><input type="checkbox" checked={product.enabled} onChange={(event) => setProduct((current) => ({ ...current, enabled: event.target.checked }))} />Available for checkout</label><Button type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}Save secure mapping</Button></form>
            <form onSubmit={activateManual}><div><p className="eyebrow">Audited override</p><h2>Activate manually</h2><p>Use for bank transfer, contract, or complimentary access. This creates no invoice or automatic renewal.</p></div><label>Organization ID<input required value={manual.organizationId} onChange={(event) => setManual((current) => ({ ...current, organizationId: event.target.value.toLowerCase() }))} /></label><div className="platform-form-row"><label>Package<select value={manual.planId} onChange={(event) => setManual((current) => ({ ...current, planId: event.target.value as PlanId }))}>{planIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label><label>Cycle<select value={manual.billingCycle} onChange={(event) => setManual((current) => ({ ...current, billingCycle: event.target.value as BillingCycle }))}>{billingCycles.map((cycle) => <option key={cycle}>{cycle}</option>)}</select></label></div><label>End date (optional)<input type="date" value={manual.endsAt} onChange={(event) => setManual((current) => ({ ...current, endsAt: event.target.value }))} /></label><label>Reason<textarea required minLength={5} value={manual.reason} onChange={(event) => setManual((current) => ({ ...current, reason: event.target.value }))} /></label><Button type="submit" variant="secondary" disabled={busy}>Activate package</Button></form>
          </aside>
        </div>
      </main>
    </AccountGuard>
  );
}
