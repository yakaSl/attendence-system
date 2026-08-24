"use client";

import { ArrowLeft, ArrowRight, Check, CreditCard, LoaderCircle, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { AccountGuard } from "@/components/account-guard";
import { BrandLogo } from "@/components/brand-logo";
import { ErrorState } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import { billingCycles, formatLkr, planPrice, saasPlans, type BillingCycle, type PlanId } from "@/lib/billing/catalog";
import { usePlanAvailability } from "@/lib/billing/availability";
import { useSubscription } from "@/lib/billing/subscription-provider";
import { createSubscriptionCheckout } from "@/lib/firebase/actions";

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/FirebaseError:\s*/i, "").replace(/^functions\//, "") : "Checkout could not be opened.";
}

export function SubscribeScreen({ initialPlan, initialCycle, cancelled }: {
  initialPlan: PlanId;
  initialCycle: BillingCycle;
  cancelled: boolean;
}) {
  const { user, logout } = useAuth();
  const { subscription } = useSubscription();
  const [planId, setPlanId] = useState<PlanId>(initialPlan);
  const [cycle, setCycle] = useState<BillingCycle>(initialCycle);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availability = usePlanAvailability();

  async function checkout() {
    if (user === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createSubscriptionCheckout({ organizationId: user.organizationId, planId, billingCycle: cycle });
      window.location.assign(result.checkoutUrl);
    } catch (checkoutError) {
      setError(safeMessage(checkoutError));
      setSubmitting(false);
    }
  }

  const selected = saasPlans.find((plan) => plan.id === planId) ?? saasPlans[1];
  return (
    <AccountGuard>
      <main className="subscribe-page">
        <header className="subscribe-topbar">
          <Link href="/" className="marketing-brand" aria-label="Infact Pulse home"><BrandLogo priority /></Link>
          <div><span>{user?.email}</span><button type="button" onClick={() => void logout()}>Sign out</button></div>
        </header>
        <section className="subscribe-heading">
          <p className="eyebrow">Step 3 of 3</p>
          <h1>Choose how your workspace starts.</h1>
          <p>Review the capacity, choose a billing cycle, then continue to Dodo&apos;s secure checkout. Your first charge is after the 14-day trial.</p>
        </section>
        {cancelled ? <div className="subscribe-notice">Checkout was closed. Nothing was charged and your package selection is still here.</div> : null}
        {subscription?.accessStatus === "active" ? (
          <div className="subscription-active-notice"><Check size={18} /><div><strong>Your {subscription.planName} access is active.</strong><span>The webhook has confirmed the subscription. Your workspace is ready.</span></div><Link href="/dashboard">Open workspace <ArrowRight size={15} /></Link></div>
        ) : null}
        {error ? <ErrorState message={error} /> : null}
        <div className="subscribe-layout">
          <div className="subscribe-plan-list">
            {saasPlans.map((plan) => (
              <button type="button" key={plan.id} className={planId === plan.id ? "subscribe-plan active" : "subscribe-plan"} onClick={() => setPlanId(plan.id)}>
                <span className="subscribe-plan-radio" />
                <span><strong>{plan.name}</strong><small>{plan.limits.employees} employees · {plan.limits.devices} devices · {plan.limits.branches ?? "Unlimited"} branches</small></span>
                <span><strong>LKR {formatLkr(planPrice(plan, cycle))}</strong><small>/{cycle === "annual" ? "year" : "month"}</small></span>
              </button>
            ))}
          </div>
          <aside className="subscribe-order">
            <div className="billing-cycle-switch">
              {billingCycles.map((option) => <button type="button" key={option} className={cycle === option ? "active" : ""} onClick={() => setCycle(option)}>{option === "monthly" ? "Monthly" : "Annual"}{option === "annual" ? <small>Save 16.7%</small> : null}</button>)}
            </div>
            <p className="eyebrow">Order summary</p>
            <h2>{selected.name}</h2>
            <div className="subscribe-total"><span>LKR</span><strong>{formatLkr(planPrice(selected, cycle))}</strong><small>per {cycle === "annual" ? "year" : "month"}</small></div>
            <div className="subscribe-trial"><span>Due today</span><strong>LKR 0</strong><small>14-day trial, then recurring {cycle} billing</small></div>
            <ul>
              <li><Check size={14} />{selected.limits.employees} employees</li>
              <li><Check size={14} />{selected.limits.devices} HikBridge devices</li>
              <li><Check size={14} />{selected.limits.branches ?? "Unlimited"} branches</li>
              <li><Check size={14} />{selected.limits.historyYears} years of history</li>
            </ul>
            <button className="subscribe-checkout" type="button" onClick={() => void checkout()} disabled={submitting || subscription?.accessStatus === "active" || !availability[planId][cycle]}>
              {submitting ? <><LoaderCircle className="spin" size={16} />Opening secure checkout</> : <><CreditCard size={16} />Continue with Dodo<ArrowRight size={16} /></>}
            </button>
            {!availability[planId][cycle] ? <p className="subscribe-unavailable">The platform owner has not enabled this package-cycle for checkout.</p> : null}
            <p className="subscribe-secure"><ShieldCheck size={14} />Your payment details never pass through Infact Pulse.</p>
          </aside>
        </div>
        <Link className="subscribe-back" href="/pricing"><ArrowLeft size={14} />Compare package details</Link>
      </main>
    </AccountGuard>
  );
}
