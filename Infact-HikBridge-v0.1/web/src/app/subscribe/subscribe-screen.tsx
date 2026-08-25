"use client";

import { ArrowLeft, ArrowRight, Check, CreditCard, LoaderCircle, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AccountGuard } from "@/components/account-guard";
import { BrandLogo } from "@/components/brand-logo";
import { ErrorState, LoadingState } from "@/components/ui";
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
  const { subscription, loading: subscriptionLoading, error: subscriptionError } = useSubscription();
  const router = useRouter();
  const [planId, setPlanId] = useState<PlanId>(initialPlan);
  const [cycle, setCycle] = useState<BillingCycle>(initialCycle);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availability = usePlanAvailability();

  useEffect(() => {
    if (subscription?.accessStatus === "active") router.replace("/dashboard");
  }, [router, subscription?.accessStatus]);

  async function checkout() {
    if (user === null || user.organizationId === null) return;
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
  const selectedPrice = planPrice(selected, cycle);

  return (
    <AccountGuard>
      <main className="subscribe-page pulse-subscribe-page">
        <header className="subscribe-topbar">
          <Link href="/" className="marketing-brand" aria-label="Infact Pulse home"><BrandLogo priority /></Link>
          <div><span>{user?.email}</span><button type="button" onClick={() => void logout()}>Sign out</button></div>
        </header>

        <section className="subscribe-heading">
          <div>
            <p className="pulse-section-label">Your workspace is ready</p>
            <h1>One last choice.<br />Then you&apos;re in.</h1>
            <p>Pick the capacity and billing rhythm that fit today. You can manage the subscription from your account later.</p>
          </div>
          <ol aria-label="Setup progress">
            <li className="complete"><span><Check size={12} /></span>Account</li>
            <li className="complete"><span><Check size={12} /></span>Workspace</li>
            <li className="active"><span>03</span>Plan</li>
          </ol>
        </section>

        {cancelled ? <div className="subscribe-notice">Checkout was closed. Nothing was charged, and your selection is still here.</div> : null}
        {subscription?.accessStatus === "active" ? (
          <div className="subscription-active-notice"><Check size={18} /><div><strong>Your {subscription.planName} access is active.</strong><span>Your subscription is confirmed and the workspace is ready.</span></div><Link href="/dashboard">Open workspace <ArrowRight size={15} /></Link></div>
        ) : null}
        {subscriptionLoading ? <LoadingState label="Checking your current package" /> : null}
        {subscriptionError ? <ErrorState message={subscriptionError} /> : null}
        {error ? <ErrorState message={error} /> : null}

        <div className="subscribe-layout">
          <section className="subscribe-choice" aria-labelledby="choose-plan-title">
            <div className="subscribe-choice-header">
              <div><p className="eyebrow">Plan capacity</p><h2 id="choose-plan-title">Choose what fits now.</h2></div>
              <div className="billing-cycle-switch" aria-label="Billing cycle">
                {billingCycles.map((option) => (
                  <button type="button" key={option} className={cycle === option ? "active" : ""} onClick={() => setCycle(option)} aria-pressed={cycle === option}>
                    {option === "monthly" ? "Monthly" : "Annual"}{option === "annual" ? <small>Save 16.7%</small> : null}
                  </button>
                ))}
              </div>
            </div>

            <div className="subscribe-plan-list">
              {saasPlans.map((plan) => (
                <button
                  type="button"
                  key={plan.id}
                  className={planId === plan.id ? "subscribe-plan active" : "subscribe-plan"}
                  onClick={() => setPlanId(plan.id)}
                  aria-pressed={planId === plan.id}
                >
                  <span className="subscribe-plan-radio"><Check size={11} /></span>
                  <span className="subscribe-plan-copy">
                    <span><strong>{plan.name}</strong>{plan.featured ? <em><Sparkles size={11} /> Most popular</em> : null}</span>
                    <small>{plan.tagline}</small>
                    <span>{plan.limits.employees} employees · {plan.limits.devices} devices · {plan.limits.branches ?? "Unlimited"} branches</span>
                  </span>
                  <span className="subscribe-plan-price">
                    <strong>LKR {formatLkr(planPrice(plan, cycle))}</strong>
                    <small>per {cycle === "annual" ? "year" : "month"}</small>
                    {cycle === "annual" ? <em>Save LKR {formatLkr(plan.monthlyPriceLkr * 12 - plan.annualPriceLkr)}</em> : null}
                  </span>
                </button>
              ))}
            </div>
            <Link className="subscribe-back" href="/pricing"><ArrowLeft size={14} /> Compare every package detail</Link>
          </section>

          <aside className="subscribe-order">
            <p className="eyebrow">Your trial summary</p>
            <div className="subscribe-order-title"><h2>{selected.name}</h2><span>{cycle}</span></div>
            <p className="subscribe-order-tagline">{selected.tagline}</p>
            <div className="subscribe-trial">
              <span>Due today</span><strong>LKR 0</strong>
              <small>Full access for 14 days</small>
            </div>
            <div className="subscribe-total">
              <div><span>After the trial</span><small>Recurring {cycle} billing</small></div>
              <p><span>LKR</span><strong>{formatLkr(selectedPrice)}</strong><small>/{cycle === "annual" ? "yr" : "mo"}</small></p>
            </div>
            {cycle === "annual" ? <p className="subscribe-saving">You save LKR {formatLkr(selected.monthlyPriceLkr * 12 - selected.annualPriceLkr)} each year.</p> : null}
            <ul>
              <li><Check size={14} /><span><strong>{selected.limits.employees}</strong> employees</span></li>
              <li><Check size={14} /><span><strong>{selected.limits.devices}</strong> HikBridge devices</span></li>
              <li><Check size={14} /><span><strong>{selected.limits.branches ?? "Unlimited"}</strong> branches</span></li>
              <li><Check size={14} /><span><strong>{selected.limits.historyYears} years</strong> of history</span></li>
            </ul>
            <button className="subscribe-checkout" type="button" onClick={() => void checkout()} disabled={submitting || subscriptionLoading || subscriptionError !== null || subscription?.accessStatus === "active" || !availability[planId][cycle]}>
              {submitting ? <><LoaderCircle className="spin" size={16} />Opening secure checkout</> : <><CreditCard size={16} />Start 14-day trial<ArrowRight size={16} /></>}
            </button>
            {!availability[planId][cycle] ? <p className="subscribe-unavailable">This package and billing cycle has not been enabled for checkout yet.</p> : null}
            <p className="subscribe-secure"><ShieldCheck size={14} />Secure checkout by Dodo · Payment details never touch Pulse</p>
          </aside>
        </div>
      </main>
    </AccountGuard>
  );
}
