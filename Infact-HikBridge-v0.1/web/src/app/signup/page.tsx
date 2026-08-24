import type { Metadata } from "next";

import { billingCycles, planIds, type BillingCycle, type PlanId } from "@/lib/billing/catalog";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Start free trial" };

export default async function SignupPage({ searchParams }: {
  searchParams: Promise<{ plan?: string; cycle?: string }>;
}) {
  const query = await searchParams;
  const plan: PlanId = (planIds as readonly string[]).includes(query.plan ?? "") ? query.plan as PlanId : "silver";
  const cycle: BillingCycle = (billingCycles as readonly string[]).includes(query.cycle ?? "") ? query.cycle as BillingCycle : "annual";
  return <SignupForm initialPlan={plan} initialCycle={cycle} />;
}
