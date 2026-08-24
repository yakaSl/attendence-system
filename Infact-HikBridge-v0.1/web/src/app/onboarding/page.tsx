"use client";

import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  MapPin,
  ShieldCheck,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Button, ErrorState, LoadingState } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import { bootstrapOrganization } from "@/lib/firebase/actions";
import {
  defaultOnboardingDraft,
  onboardingSteps,
  slugifyIdentifier,
  toBootstrapRequest,
  validateOnboarding,
  validateOnboardingStep,
  weekdayOptions,
  type OnboardingDraft,
  type OnboardingStep,
} from "@/lib/onboarding";

const timezones = [
  "Asia/Colombo",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
  "UTC",
];

function FieldError({ children }: { children?: string }) {
  return children ? <small className="wizard-field-error">{children}</small> : null;
}

function ReviewRow({ label, value, icon }: { label: string; value: ReactNode; icon: ReactNode }) {
  return (
    <div className="wizard-review-row">
      <span className="wizard-review-icon">{icon}</span>
      <div><small>{label}</small><strong>{value}</strong></div>
    </div>
  );
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "Organization setup could not be completed.";
  return error.message
    .replace(/FirebaseError:\s*/i, "")
    .replace(/^functions\//, "")
    .replace(/\s*\(functions\/[a-z-]+\)\.?$/i, "");
}

export default function OnboardingPage() {
  const router = useRouter();
  const {
    user,
    identity,
    onboardingRequired,
    loading,
    error: authError,
    logout,
    refreshProfile,
  } = useAuth();
  const [step, setStep] = useState<OnboardingStep>(0);
  const [draft, setDraft] = useState<OnboardingDraft>(defaultOnboardingDraft);
  const [organizationIdManual, setOrganizationIdManual] = useState(false);
  const [branchIdManual, setBranchIdManual] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (user !== null) router.replace("/dashboard");
    else if (identity === null || !onboardingRequired) router.replace("/login");
  }, [identity, loading, onboardingRequired, router, user]);

  function update<K extends keyof OnboardingDraft>(field: K, value: OnboardingDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function updateOrganizationName(value: string) {
    setDraft((current) => ({
      ...current,
      organizationName: value,
      organizationId: organizationIdManual ? current.organizationId : slugifyIdentifier(value),
    }));
    setErrors({});
  }

  function updateBranchName(value: string) {
    setDraft((current) => ({
      ...current,
      branchName: value,
      branchId: branchIdManual ? current.branchId : slugifyIdentifier(value),
    }));
    setErrors({});
  }

  function toggleWorkingDay(day: number) {
    update(
      "workingDays",
      draft.workingDays.includes(day) ?
        draft.workingDays.filter((value) => value !== day) :
        [...draft.workingDays, day].sort(),
    );
  }

  function next() {
    const nextErrors = validateOnboardingStep(step, draft);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setStep((current) => Math.min(3, current + 1) as OnboardingStep);
  }

  function back() {
    setErrors({});
    setSubmitError(null);
    setStep((current) => Math.max(0, current - 1) as OnboardingStep);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step < 3) {
      next();
      return;
    }
    const allErrors = validateOnboarding(draft);
    if (Object.keys(allErrors).length > 0) {
      setErrors(allErrors);
      setStep(0);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await bootstrapOrganization(toBootstrapRequest(draft));
      const ready = await refreshProfile();
      if (!ready) throw new Error("Organization was created, but the workspace profile could not be refreshed.");
      router.replace("/dashboard");
      router.refresh();
    } catch (creationError) {
      setSubmitError(safeError(creationError));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <main className="centered-state"><LoadingState label="Checking your workspace" /></main>;
  if (authError) return <main className="centered-state"><ErrorState message={authError} /></main>;
  if (user !== null || identity === null || !onboardingRequired) {
    return <main className="centered-state"><LoadingState label="Opening workspace" /></main>;
  }

  return (
    <main className="onboarding-page">
      <header className="onboarding-topbar">
        <div className="onboarding-brand"><span className="brand-mark">I</span><span>Infact Attendance</span></div>
        <div className="onboarding-account">
          <span><small>Signed in as</small><strong>{identity.email || identity.displayName}</strong></span>
          <button type="button" onClick={() => void logout()}>Sign out</button>
        </div>
      </header>

      <section className="onboarding-shell">
        <aside className="wizard-rail">
          <div>
            <p className="eyebrow">First-time setup</p>
            <h1>Create your workspace.</h1>
            <p>Set the operating defaults your attendance records need from day one.</p>
          </div>
          <ol className="wizard-steps">
            {onboardingSteps.map((item, index) => {
              const complete = index < step;
              const active = index === step;
              return (
                <li key={item.label} className={active ? "wizard-step-active" : complete ? "wizard-step-complete" : ""} aria-current={active ? "step" : undefined}>
                  <span>{complete ? <Check size={14} /> : index + 1}</span>
                  <div><strong>{item.label}</strong><small>{item.note}</small></div>
                </li>
              );
            })}
          </ol>
          <div className="wizard-security-note"><ShieldCheck size={17} /><span><strong>Created atomically</strong><small>No partial organization or owner records.</small></span></div>
        </aside>

        <div className="wizard-workspace">
          <div className="wizard-progress" aria-hidden><span style={{ width: `${((step + 1) / onboardingSteps.length) * 100}%` }} /></div>
          <form className="wizard-form" onSubmit={submit}>
            <header className="wizard-heading">
              <p className="eyebrow">Step {step + 1} of {onboardingSteps.length}</p>
              {step === 0 ? <><h2>Organization identity</h2><p>This name and timezone appear throughout attendance records and reports.</p></> : null}
              {step === 1 ? <><h2>Primary branch</h2><p>Create the first location where employees and Hikvision terminals will operate.</p></> : null}
              {step === 2 ? <><h2>Attendance defaults</h2><p>Define the initial work week and shift. You can add more policies after setup.</p></> : null}
              {step === 3 ? <><h2>Review your workspace</h2><p>Confirm the operating baseline before the organization is created.</p></> : null}
            </header>

            {submitError ? <ErrorState message={submitError} /> : null}

            <div className="wizard-stage" key={step}>
              {step === 0 ? (
                <div className="wizard-field-grid">
                  <label className="wizard-field wizard-field-full">
                    <span>Organization name</span>
                    <input autoFocus required maxLength={100} placeholder="Example: Infact Solutions" value={draft.organizationName} onChange={(event) => updateOrganizationName(event.target.value)} />
                    <FieldError>{errors.organizationName}</FieldError>
                  </label>
                  <label className="wizard-field">
                    <span>Organization identifier</span>
                    <input required maxLength={63} placeholder="infact-solutions" value={draft.organizationId} onChange={(event) => {
                      setOrganizationIdManual(true);
                      update("organizationId", event.target.value.toLowerCase());
                    }} />
                    <small className="wizard-field-help">Permanent tenant path; lowercase and URL-safe.</small>
                    <FieldError>{errors.organizationId}</FieldError>
                  </label>
                  <label className="wizard-field">
                    <span>Business timezone</span>
                    <select value={draft.timezone} onChange={(event) => update("timezone", event.target.value)}>
                      {timezones.map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}
                    </select>
                    <small className="wizard-field-help">Controls attendance dates and overnight shift boundaries.</small>
                    <FieldError>{errors.timezone}</FieldError>
                  </label>
                </div>
              ) : null}

              {step === 1 ? (
                <div className="wizard-field-grid">
                  <label className="wizard-field wizard-field-full">
                    <span>Branch name</span>
                    <input autoFocus required maxLength={100} placeholder="Example: Colombo HQ" value={draft.branchName} onChange={(event) => updateBranchName(event.target.value)} />
                    <FieldError>{errors.branchName}</FieldError>
                  </label>
                  <label className="wizard-field">
                    <span>Branch identifier</span>
                    <input required maxLength={63} value={draft.branchId} onChange={(event) => {
                      setBranchIdManual(true);
                      update("branchId", event.target.value.toLowerCase());
                    }} />
                    <small className="wizard-field-help">Used by devices, employees, and reports.</small>
                    <FieldError>{errors.branchId}</FieldError>
                  </label>
                  <div className="wizard-context-block">
                    <MapPin size={19} />
                    <div><strong>Primary operating location</strong><p>New devices will be assigned to this branch during provisioning. Additional branches can be added later.</p></div>
                  </div>
                </div>
              ) : null}

              {step === 2 ? (
                <div className="wizard-field-grid">
                  <label className="wizard-field">
                    <span>Default shift name</span>
                    <input autoFocus required maxLength={100} value={draft.shiftName} onChange={(event) => update("shiftName", event.target.value)} />
                    <FieldError>{errors.shiftName}</FieldError>
                  </label>
                  <label className="wizard-field">
                    <span>Shift code</span>
                    <input required maxLength={64} value={draft.shiftId} onChange={(event) => update("shiftId", event.target.value.toUpperCase())} />
                    <FieldError>{errors.shiftId}</FieldError>
                  </label>
                  <div className="wizard-field wizard-field-full">
                    <span>Working days</span>
                    <div className="wizard-weekdays">
                      {weekdayOptions.map((day) => (
                        <button type="button" key={day.value} className={draft.workingDays.includes(day.value) ? "selected" : ""} onClick={() => toggleWorkingDay(day.value)} aria-pressed={draft.workingDays.includes(day.value)}>
                          <span>{day.short}</span><small>{day.label}</small>
                        </button>
                      ))}
                    </div>
                    <FieldError>{errors.workingDays}</FieldError>
                  </div>
                  <label className="wizard-field">
                    <span>Starts</span>
                    <input type="time" required value={draft.startTime} onChange={(event) => update("startTime", event.target.value)} />
                  </label>
                  <label className="wizard-field">
                    <span>Ends</span>
                    <input type="time" required value={draft.endTime} onChange={(event) => update("endTime", event.target.value)} />
                    <FieldError>{errors.endTime}</FieldError>
                  </label>
                  <label className="wizard-field">
                    <span>Grace period</span>
                    <div className="wizard-number-input"><input type="number" min={0} max={240} value={draft.gracePeriodMinutes} onChange={(event) => update("gracePeriodMinutes", Number(event.target.value))} /><small>minutes</small></div>
                    <FieldError>{errors.gracePeriodMinutes}</FieldError>
                  </label>
                  <label className="wizard-field">
                    <span>Unpaid break</span>
                    <div className="wizard-number-input"><input type="number" min={0} max={480} value={draft.breakMinutes} onChange={(event) => update("breakMinutes", Number(event.target.value))} /><small>minutes</small></div>
                    <FieldError>{errors.breakMinutes}</FieldError>
                  </label>
                  <label className="wizard-field">
                    <span>Late-minute calculation</span>
                    <select value={draft.lateCalculationMode} onChange={(event) => update("lateCalculationMode", event.target.value as OnboardingDraft["lateCalculationMode"])}>
                      <option value="after_grace">Count after grace period</option>
                      <option value="from_shift_start">Count from shift start</option>
                    </select>
                  </label>
                  <div className="wizard-policy-note">
                    <ShieldCheck size={18} />
                    <p><strong>Missing punches are flagged for HR review.</strong><span>This protects attendance records from automatic assumptions.</span></p>
                  </div>
                </div>
              ) : null}

              {step === 3 ? (
                <div className="wizard-review">
                  <div className="wizard-review-group">
                    <p>Workspace</p>
                    <ReviewRow icon={<Building2 size={18} />} label="Organization" value={<>{draft.organizationName}<small>{draft.organizationId}</small></>} />
                    <ReviewRow icon={<MapPin size={18} />} label="Primary branch" value={<>{draft.branchName}<small>{draft.branchId}</small></>} />
                  </div>
                  <div className="wizard-review-group">
                    <p>Attendance baseline</p>
                    <ReviewRow icon={<Clock3 size={18} />} label="Default shift" value={<>{draft.shiftName} · {draft.startTime}–{draft.endTime}<small>{draft.gracePeriodMinutes} min grace · {draft.breakMinutes} min break</small></>} />
                    <ReviewRow icon={<CalendarDays size={18} />} label="Working week" value={weekdayOptions.filter((day) => draft.workingDays.includes(day.value)).map((day) => day.short).join(", ")} />
                    <ReviewRow icon={<CheckCircle2 size={18} />} label="Exception policy" value="Missing punches require HR review" />
                  </div>
                  <div className="wizard-final-note"><ShieldCheck size={19} /><p><strong>You become the organization owner.</strong><span>The profile, membership, branch, shift, and audit record are created in one transaction.</span></p></div>
                </div>
              ) : null}
            </div>

            <footer className="wizard-actions">
              <Button type="button" variant="quiet" onClick={back} disabled={step === 0 || submitting}><ArrowLeft size={15} />Back</Button>
              <span>Required settings only. More policies are available in Settings.</span>
              {step < 3 ? <Button type="submit">Continue<ArrowRight size={15} /></Button> : (
                <Button type="submit" disabled={submitting}>
                  {submitting ? <><LoaderCircle className="spin" size={15} />Creating workspace</> : <><CheckCircle2 size={15} />Create organization</>}
                </Button>
              )}
            </footer>
          </form>
        </div>
      </section>
    </main>
  );
}
