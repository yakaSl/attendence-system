"use client";

import { Fingerprint, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { BrandLogo } from "@/components/brand-logo";
import { Button, ErrorState } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";

export default function LoginPage() {
  const router = useRouter();
  const { user, identity, onboardingRequired, login, loading, error, demo } = useAuth();
  const [email, setEmail] = useState(demo ? "hr@infact.demo" : "");
  const [password, setPassword] = useState(demo ? "demo-access" : "");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (onboardingRequired && identity !== null) router.replace("/onboarding");
    else if (user !== null) router.replace("/dashboard");
  }, [identity, loading, onboardingRequired, router, user]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await login(email, password);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-intro">
        <div className="login-brand"><BrandLogo priority /></div>
        <div>
          <p className="eyebrow">Hikvision-connected workforce operations</p>
          <h1>Attendance evidence, reconciled and ready for HR.</h1>
          <p>Monitor devices, resolve missing punches, review exceptions, and produce payroll-ready summaries from one controlled workspace.</p>
        </div>
        <div className="login-proof">
          <span><Fingerprint size={18} />Immutable device events</span>
          <span><LockKeyhole size={18} />Role-controlled corrections</span>
        </div>
      </section>
      <section className="login-form-wrap">
        <form className="login-form" onSubmit={submit}>
          <div><p className="eyebrow">Secure workspace</p><h2>Sign in</h2><p>Use your organization account to continue.</p></div>
          {demo ? <div className="demo-notice">Demo mode is active. The prefilled account opens a non-persistent sample workspace.</div> : null}
          {error ? <ErrorState message={error} /> : null}
          <label>Email address<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" required minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <Button type="submit" disabled={submitting}>{submitting ? "Signing in…" : "Continue to workspace"}</Button>
          <p className="signup-signin">New to Infact Pulse? <Link href="/pricing">View packages and start free</Link></p>
          <small>Access and activity are recorded under your authenticated account.</small>
        </form>
      </section>
    </main>
  );
}
