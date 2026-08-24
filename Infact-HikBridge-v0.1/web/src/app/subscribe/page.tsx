import { billingCycles, planIds, type BillingCycle, type PlanId } from "@/lib/billing/catalog";
import { SubscribeScreen } from "./subscribe-screen";

export default async function SubscribePage({ searchParams }: {
  searchParams: Promise<{ plan?: string; cycle?: string; cancelled?: string }>;
}) {
  const query = await searchParams;
  const plan: PlanId = (planIds as readonly string[]).includes(query.plan ?? "") ? query.plan as PlanId : "silver";
  const cycle: BillingCycle = (billingCycles as readonly string[]).includes(query.cycle ?? "") ? query.cycle as BillingCycle : "annual";
  return <SubscribeScreen initialPlan={plan} initialCycle={cycle} cancelled={query.cancelled === "1"} />;
}
