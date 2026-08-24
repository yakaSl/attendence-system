"use client";

import { ArrowRight, Check, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { billingCycles, formatLkr, planPrice, saasPlans, trialPeriodDays, type BillingCycle } from "@/lib/billing/catalog";
import { usePlanAvailability } from "@/lib/billing/availability";

export function PlanSelector({ compact = false, destination = "/signup" }: { compact?: boolean; destination?: "/signup" | "/subscribe" }) {
  const [cycle, setCycle] = useState<BillingCycle>("annual");
  const availability = usePlanAvailability();

  return (
    <div className={compact ? "plan-selector plan-selector-compact" : "plan-selector"}>
      <div className="billing-cycle-switch" aria-label="Billing cycle">
        {billingCycles.map((option) => (
          <button key={option} type="button" className={cycle === option ? "active" : ""} onClick={() => setCycle(option)} aria-pressed={cycle === option}>
            {option === "monthly" ? "Monthly" : "Annual"}
            {option === "annual" ? <small>2 months free</small> : null}
          </button>
        ))}
      </div>

      <div className="plan-columns">
        {saasPlans.map((plan) => {
          const price = planPrice(plan, cycle);
          const branchLabel = plan.limits.branches === null ? "Unlimited branches" : `${plan.limits.branches} ${plan.limits.branches === 1 ? "branch" : "branches"}`;
          return (
            <article key={plan.id} className={plan.featured ? "plan-column plan-column-featured" : "plan-column"}>
              <div className="plan-column-heading">
                <span>{plan.featured ? <><Sparkles size={13} /> Most popular</> : "Pulse package"}</span>
                <h3>{plan.name}</h3>
                <p>{plan.tagline}</p>
              </div>
              <div className="plan-price" key={`${plan.id}-${cycle}`}>
                <small>LKR</small><strong>{formatLkr(price)}</strong><span>/{cycle === "annual" ? "year" : "month"}</span>
              </div>
              {cycle === "annual" ? <p className="plan-saving">Save LKR {formatLkr(plan.monthlyPriceLkr * 12 - plan.annualPriceLkr)} each year</p> : <p className="plan-saving">Flexible month-to-month billing</p>}
              <ul>
                <li><Check size={14} />Up to {plan.limits.employees.toLocaleString()} employees</li>
                <li><Check size={14} />{plan.limits.devices} HikBridge {plan.limits.devices === 1 ? "device" : "devices"}</li>
                <li><Check size={14} />{branchLabel}</li>
                <li><Check size={14} />{plan.limits.adminUsers} admin users</li>
                <li><Check size={14} />{plan.limits.historyYears}-year data history</li>
                <li><Check size={14} />{plan.support}</li>
              </ul>
              {availability[plan.id][cycle] ? (
                <Link className="plan-choose" href={`${destination}?plan=${plan.id}&cycle=${cycle}`}>
                  Start {trialPeriodDays}-day trial <ArrowRight size={15} />
                </Link>
              ) : <span className="plan-choose plan-unavailable">This billing cycle is unavailable</span>}
            </article>
          );
        })}
      </div>
      <p className="pricing-footnote">All packages include attendance dashboards, shift rules, device sync, corrections, and payroll-ready reports. Prices exclude applicable taxes.</p>
    </div>
  );
}
