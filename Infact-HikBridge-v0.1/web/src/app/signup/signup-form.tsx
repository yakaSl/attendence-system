"use client";

import { ArrowLeft, Check, LoaderCircle, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { BrandLogo } from "@/components/brand-logo";
import { Button, ErrorState } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import { formatLkr, planById, planPrice, type BillingCycle, type PlanId } from "@/lib/billing/catalog";

export function SignupForm({ initialPlan, initialCycle }: { initialPlan: PlanId; initialCycle: BillingCycle }) {
  const router = useRouter();
  const { user, identity, onboardingRequired, signup, loading, error } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const plan = planById(initialPlan);

  useEffect(() => {
    if (loading) return;
    if (onboardingRequired && identity !== null) router.replace("/onboarding");
    else if (user !== null) router.replace("/dashboard");
  }, [identity, loading, onboardingRequired, router, user]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    sessionStorage.setItem("infact_selected_plan", initialPlan);
    sessionStorage.setItem("infact_selected_cycle", initialCycle);
    try {
      await signup(name, email, password);
      router.replace("/onboarding");
    } finally {
      setSubmitting(false);
    }
  }

  if (plan === null) return null;
  return (
    <main className="signup-page">
      <section className="signup-summary">
        <Link href="/pricing" className="signup-back"><ArrowLeft size={14} />Change package</Link>
        <div className="signup-brand"><BrandLogo priority /></div>
        <div>
          <p className="marketing-kicker">Selected package</p>
          <h1>{plan.name}</h1>
          <p>{plan.tagline}</p>
          <div className="signup-price"><small>LKR</small><strong>{formatLkr(planPrice(plan, initialCycle))}</strong><span>/{initialCycle === "annual" ? "year" : "month"}</span></div>
          <ul>
            <li><Check size={14} />14-day free trial</li>
            <li><Check size={14} />{plan.limits.employees} employees and {plan.limits.devices} devices</li>
            <li><Check size={14} />Full attendance and reporting feature set</li>
            <li><Check size={14} />Cancel from the billing portal</li>
          </ul>
        </div>
        <p className="signup-security"><ShieldCheck size={16} />Payment details are collected later on Dodo&apos;s hosted checkout.</p>
      </section>
      <section className="signup-form-wrap">
        <form className="signup-form" onSubmit={submit}>
          <div><p className="eyebrow">Step 1 of 3</p><h2>Create your owner account</h2><p>Next, we&apos;ll set up the organization and securely start your trial.</p></div>
          {error ? <ErrorState message={error} /> : null}
          <label>Full name<input required autoComplete="name" minLength={2} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Work email<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input required type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /><small>Use at least 8 characters.</small></label>
          <Button type="submit" disabled={submitting}>{submitting ? <><LoaderCircle className="spin" size={15} />Creating account</> : "Continue to organization setup"}</Button>
          <p className="signup-signin">Already have an account? <Link href="/login">Sign in</Link></p>
        </form>
      </section>
    </main>
  );
}
