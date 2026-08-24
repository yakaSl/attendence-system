export const planIds = ["bronze", "silver", "gold", "platinum"] as const;
export const billingCycles = ["monthly", "annual"] as const;

export type PlanId = typeof planIds[number];
export type BillingCycle = typeof billingCycles[number];

export interface PlanLimits {
  employees: number;
  devices: number;
  branches: number | null;
  adminUsers: number;
  historyYears: number;
}

export interface SaasPlan {
  id: PlanId;
  name: string;
  tagline: string;
  monthlyPriceLkr: number;
  annualPriceLkr: number;
  featured: boolean;
  support: string;
  limits: PlanLimits;
}

export const trialPeriodDays = 14;

export const saasPlans: readonly SaasPlan[] = [
  {
    id: "bronze",
    name: "Bronze",
    tagline: "A dependable start for one small workplace.",
    monthlyPriceLkr: 4_900,
    annualPriceLkr: 49_000,
    featured: false,
    support: "Email support",
    limits: { employees: 25, devices: 1, branches: 1, adminUsers: 3, historyYears: 1 },
  },
  {
    id: "silver",
    name: "Silver",
    tagline: "The practical choice for a growing operation.",
    monthlyPriceLkr: 9_900,
    annualPriceLkr: 99_000,
    featured: true,
    support: "Priority email support",
    limits: { employees: 100, devices: 3, branches: 3, adminUsers: 10, historyYears: 2 },
  },
  {
    id: "gold",
    name: "Gold",
    tagline: "More locations, terminals, and reporting depth.",
    monthlyPriceLkr: 19_900,
    annualPriceLkr: 199_000,
    featured: false,
    support: "Priority email and phone support",
    limits: { employees: 300, devices: 10, branches: 10, adminUsers: 25, historyYears: 5 },
  },
  {
    id: "platinum",
    name: "Platinum",
    tagline: "High-capacity attendance operations at scale.",
    monthlyPriceLkr: 39_900,
    annualPriceLkr: 399_000,
    featured: false,
    support: "Named onboarding and priority support",
    limits: { employees: 1_000, devices: 25, branches: null, adminUsers: 50, historyYears: 7 },
  },
] as const;

export function planById(planId: PlanId): SaasPlan {
  const plan = saasPlans.find((candidate) => candidate.id === planId);
  if (plan === undefined) throw new Error(`Unknown SaaS plan: ${planId}`);
  return plan;
}

export function priceForCycle(plan: SaasPlan, cycle: BillingCycle): number {
  return cycle === "annual" ? plan.annualPriceLkr : plan.monthlyPriceLkr;
}

export function billingProductKey(planId: PlanId, cycle: BillingCycle): string {
  return `${planId}_${cycle}`;
}
