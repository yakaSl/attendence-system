export type OnboardingStep = 0 | 1 | 2 | 3;
export type LateCalculationMode = "from_shift_start" | "after_grace";
export type MissingPunchPolicy = "flag_exception";

export interface OnboardingDraft {
  organizationName: string;
  organizationId: string;
  timezone: string;
  branchName: string;
  branchId: string;
  shiftName: string;
  shiftId: string;
  startTime: string;
  endTime: string;
  workingDays: number[];
  gracePeriodMinutes: number;
  breakMinutes: number;
  lateCalculationMode: LateCalculationMode;
  missingPunchPolicy: MissingPunchPolicy;
}

export type BootstrapOrganizationRequest = OnboardingDraft;

export const weekdayOptions = [
  { value: 1, short: "Mon", label: "Monday" },
  { value: 2, short: "Tue", label: "Tuesday" },
  { value: 3, short: "Wed", label: "Wednesday" },
  { value: 4, short: "Thu", label: "Thursday" },
  { value: 5, short: "Fri", label: "Friday" },
  { value: 6, short: "Sat", label: "Saturday" },
  { value: 7, short: "Sun", label: "Sunday" },
] as const;

export const onboardingSteps = [
  { label: "Organization", note: "Identity and timezone" },
  { label: "Primary branch", note: "First operating location" },
  { label: "Attendance", note: "Default work policy" },
  { label: "Review", note: "Confirm and create" },
] as const;

export const defaultOnboardingDraft: OnboardingDraft = {
  organizationName: "",
  organizationId: "",
  timezone: "Asia/Colombo",
  branchName: "Colombo HQ",
  branchId: "colombo",
  shiftName: "Normal Shift",
  shiftId: "NORMAL",
  startTime: "08:30",
  endTime: "17:30",
  workingDays: [1, 2, 3, 4, 5],
  gracePeriodMinutes: 10,
  breakMinutes: 60,
  lateCalculationMode: "after_grace",
  missingPunchPolicy: "flag_exception",
};

export function slugifyIdentifier(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function validIdentifier(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}$/.test(value);
}

function validTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat("en", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function validateOnboardingStep(step: OnboardingStep, draft: OnboardingDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (step === 0) {
    if (draft.organizationName.trim().length < 2) errors.organizationName = "Enter an organization name.";
    if (!validIdentifier(draft.organizationId)) errors.organizationId = "Use 2–63 lowercase letters, numbers, or hyphens.";
    if (!validTimezone(draft.timezone)) errors.timezone = "Choose a valid IANA timezone.";
  }
  if (step === 1) {
    if (draft.branchName.trim().length < 2) errors.branchName = "Enter a branch name.";
    if (!validIdentifier(draft.branchId)) errors.branchId = "Use 2–63 lowercase letters, numbers, or hyphens.";
  }
  if (step === 2) {
    if (draft.shiftName.trim().length < 2) errors.shiftName = "Enter a default shift name.";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(draft.shiftId)) errors.shiftId = "Use letters, numbers, underscores, or hyphens.";
    if (draft.startTime === draft.endTime) errors.endTime = "Start and end times cannot match.";
    if (draft.workingDays.length === 0) errors.workingDays = "Select at least one working day.";
    if (!Number.isInteger(draft.gracePeriodMinutes) || draft.gracePeriodMinutes < 0 || draft.gracePeriodMinutes > 240) {
      errors.gracePeriodMinutes = "Enter 0–240 minutes.";
    }
    if (!Number.isInteger(draft.breakMinutes) || draft.breakMinutes < 0 || draft.breakMinutes > 480) {
      errors.breakMinutes = "Enter 0–480 minutes.";
    }
  }
  return errors;
}

export function validateOnboarding(draft: OnboardingDraft): Record<string, string> {
  return ([0, 1, 2] as OnboardingStep[]).reduce(
    (errors, step) => ({ ...errors, ...validateOnboardingStep(step, draft) }),
    {},
  );
}

export function toBootstrapRequest(draft: OnboardingDraft): BootstrapOrganizationRequest {
  return {
    ...draft,
    organizationName: draft.organizationName.trim(),
    organizationId: draft.organizationId.trim(),
    branchName: draft.branchName.trim(),
    branchId: draft.branchId.trim(),
    shiftName: draft.shiftName.trim(),
    shiftId: draft.shiftId.trim(),
    workingDays: [...new Set(draft.workingDays)].sort(),
  };
}
