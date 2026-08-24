"use client";

import { CheckCircle2, LoaderCircle } from "lucide-react";
import Link from "next/link";

import { AccountGuard } from "@/components/account-guard";
import { useSubscription } from "@/lib/billing/subscription-provider";

export default function SubscriptionSuccessPage() {
  const { subscription, loading, error } = useSubscription();
  const active = subscription?.accessStatus === "active";
  return (
    <AccountGuard>
      <main className="checkout-result-page">
        <div className={active ? "checkout-result-icon active" : "checkout-result-icon"}>{active ? <CheckCircle2 size={32} /> : <LoaderCircle className="spin" size={30} />}</div>
        <p className="eyebrow">Dodo checkout complete</p>
        <h1>{active ? "Your workspace is ready." : "We’re confirming your subscription."}</h1>
        <p>{active ? `The ${subscription.planName} package is active. Attendance operations are now unlocked.` : "The signed payment webhook normally arrives in a few seconds. Keep this page open while we confirm access."}</p>
        {error ? <p className="danger-text">{error}</p> : null}
        {active ? <Link href="/dashboard">Open workspace</Link> : <button type="button" onClick={() => window.location.reload()} disabled={loading}>Check again</button>}
        {!active ? <Link className="checkout-result-secondary" href="/subscribe">Return to packages</Link> : null}
      </main>
    </AccountGuard>
  );
}
