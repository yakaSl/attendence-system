"use client";

import { ArrowLeft, ArrowUpRight, CalendarDays, Check, CreditCard, LoaderCircle, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { AccountGuard } from "@/components/account-guard";
import { ErrorState, LoadingState } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import { formatLkr, planById } from "@/lib/billing/catalog";
import { useSubscription } from "@/lib/billing/subscription-provider";
import { createCustomerPortalSession } from "@/lib/firebase/actions";

function formatDate(value: string | null): string {
  return value === null ? "No fixed end date" : new Intl.DateTimeFormat("en-LK", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

export default function BillingPage() {
  const { user } = useAuth();
  const { subscription, loading, error } = useSubscription();
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const plan = planById(subscription?.planId);

  async function openPortal() {
    if (user === null) return;
    setPortalLoading(true);
    setPortalError(null);
    try {
      const result = await createCustomerPortalSession({ organizationId: user.organizationId });
      window.location.assign(result.portalUrl);
    } catch (requestError) {
      setPortalError(requestError instanceof Error ? requestError.message : "Billing portal could not be opened.");
      setPortalLoading(false);
    }
  }

  return (
    <AccountGuard>
      <main className="billing-page">
        <header className="billing-header">
          <div><Link href={subscription?.accessStatus === "active" ? "/dashboard" : "/subscribe"}><ArrowLeft size={14} />Back</Link><p className="eyebrow">Organization billing</p><h1>Package and payment settings</h1></div>
          <span className={subscription?.accessStatus === "active" ? "billing-access active" : "billing-access"}><span />{subscription?.accessStatus ?? "No package"}</span>
        </header>
        {loading ? <LoadingState label="Loading subscription" /> : null}
        {error ? <ErrorState message={error} /> : null}
        {portalError ? <ErrorState message={portalError} /> : null}
        {!loading && subscription === null ? (
          <section className="billing-empty"><CreditCard size={25} /><h2>No package is active</h2><p>Select a package to start the workspace trial or contact the platform owner for a manual activation.</p><Link href="/subscribe">Choose a package</Link></section>
        ) : null}
        {subscription !== null && plan !== null ? (
          <>
            <section className="billing-overview">
              <div className="billing-plan-name"><p>Current package</p><h2>{plan.name}</h2><span>{subscription.source === "dodo" ? "Dodo Payments" : "Manually managed"}</span></div>
              <div className="billing-price"><p>Recurring price</p><strong><small>LKR</small>{formatLkr(subscription.priceLkr)}</strong><span>per {subscription.billingCycle === "annual" ? "year" : "month"}</span></div>
              <div className="billing-renewal"><CalendarDays size={18} /><p><span>{subscription.cancelAtPeriodEnd ? "Access ends" : subscription.source === "dodo" ? "Next renewal" : "Manual term"}</span><strong>{formatDate(subscription.currentPeriodEnd ?? subscription.endsAt)}</strong></p></div>
              {subscription.source === "dodo" ? <button type="button" onClick={() => void openPortal()} disabled={portalLoading}>{portalLoading ? <LoaderCircle className="spin" size={15} /> : <CreditCard size={15} />}Manage with Dodo<ArrowUpRight size={14} /></button> : <p className="billing-manual-note"><ShieldCheck size={16} />Changes to this package are handled by the platform owner.</p>}
            </section>
            <section className="billing-capacity">
              <div><p className="eyebrow">Included capacity</p><h2>What this workspace can operate</h2><p>Creation limits are checked by trusted server functions, including calls made outside the browser interface.</p></div>
              <ul>
                <li><Check size={15} /><span><strong>{plan.limits.employees.toLocaleString()}</strong>employees</span></li>
                <li><Check size={15} /><span><strong>{plan.limits.devices}</strong>HikBridge devices</span></li>
                <li><Check size={15} /><span><strong>{plan.limits.branches ?? "Unlimited"}</strong>branches</span></li>
                <li><Check size={15} /><span><strong>{plan.limits.adminUsers}</strong>admin users</span></li>
                <li><Check size={15} /><span><strong>{plan.limits.historyYears} years</strong>data history</span></li>
              </ul>
            </section>
            <section className="billing-explainer"><ShieldCheck size={20} /><div><h2>What “paused” means</h2><p>Workspace access and new management actions stop immediately. HikBridge can continue delivering already-recorded attendance so physical punch evidence is not lost while billing is resolved.</p></div></section>
          </>
        ) : null}
      </main>
    </AccountGuard>
  );
}
