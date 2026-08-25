import { ArrowRight, CalendarCheck2, CheckCircle2, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { BrandLogo } from "@/components/brand-logo";
import { MarketingHeader } from "@/components/marketing-header";
import { PlanSelector } from "@/components/plan-selector";

export const metadata: Metadata = {
  title: "Packages",
  description: "Transparent LKR monthly and annual packages for Infact Pulse.",
};

export default function PricingPage() {
  return (
    <main className="marketing-page pricing-page pulse-pricing-page">
      <MarketingHeader />
      <header className="pricing-hero">
        <div>
          <p className="pulse-section-label">Pricing without the puzzle</p>
          <h1>Full Pulse.<br />Sized for your team.</h1>
          <p>Every package includes the complete attendance operation. You only choose the capacity your workplace needs.</p>
          <Link href="#compare-plans">Compare packages <ArrowRight size={16} /></Link>
        </div>
        <aside aria-label="Package assurances">
          <p><span><CalendarCheck2 size={17} /></span><strong>14 days free</strong><small>Explore the full workflow before your first payment.</small></p>
          <p><span><CheckCircle2 size={17} /></span><strong>Two months free annually</strong><small>A simple annual saving with the exact total shown.</small></p>
          <p><span><ShieldCheck size={17} /></span><strong>Secure hosted checkout</strong><small>Payment details never pass through Infact Pulse.</small></p>
        </aside>
      </header>

      <section className="pricing-full" id="compare-plans">
        <div className="pricing-section-intro">
          <p className="pulse-section-label">Choose your capacity</p>
          <h2>Start where you are.<br />Move up when you need to.</h2>
        </div>
        <PlanSelector />
      </section>

      <section className="pricing-assurance">
        <p><span>01</span><strong>One trial per organization</strong><small>Your chosen billing cycle starts after 14 days unless you cancel.</small></p>
        <p><span>02</span><strong>Clear, recurring billing</strong><small>Review the exact monthly or annual total before hosted checkout.</small></p>
        <p><span>03</span><strong>Manual agreements available</strong><small>A platform owner can activate an audited package with a defined end date.</small></p>
      </section>

      <section className="pricing-final">
        <p className="pulse-section-label">Still deciding?</p>
        <h2>Silver is built for most growing teams.</h2>
        <Link href="/signup?plan=silver&cycle=annual">Start with Silver <ArrowRight size={16} /></Link>
      </section>

      <footer className="marketing-footer">
        <BrandLogo />
        <span>Transparent LKR billing for Sri Lankan workplaces</span>
        <div><Link href="/">Home</Link><Link href="/login">Sign in</Link></div>
      </footer>
    </main>
  );
}
