import type { Metadata } from "next";

import { MarketingHeader } from "@/components/marketing-header";
import { PlanSelector } from "@/components/plan-selector";

export const metadata: Metadata = {
  title: "Packages",
  description: "LKR monthly and annual packages for Infact Pulse.",
};

export default function PricingPage() {
  return (
    <main className="marketing-page pricing-page">
      <MarketingHeader />
      <header className="pricing-hero">
        <p className="marketing-kicker">Simple capacity-based pricing</p>
        <h1>The complete attendance operation, sized for your workplace.</h1>
        <p>Try any package for 14 days. Annual billing includes two months free, and you can manage the subscription from your account.</p>
      </header>
      <section className="pricing-full"><PlanSelector /></section>
      <section className="pricing-assurance">
        <p><strong>One trial per organization</strong><span>Your selected cycle starts automatically after 14 days unless cancelled.</span></p>
        <p><strong>Secure hosted checkout</strong><span>Dodo Payments handles payment details; Infact Pulse stores subscription state and entitlements.</span></p>
        <p><strong>Need a manual agreement?</strong><span>A platform owner can activate a monthly or annual package with an audited reason and end date.</span></p>
      </section>
    </main>
  );
}
