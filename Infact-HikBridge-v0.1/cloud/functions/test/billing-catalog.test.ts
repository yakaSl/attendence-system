import { describe, expect, it } from "vitest";

import { billingProductKey, planById, priceForCycle, saasPlans, trialPeriodDays } from "../src/billing/catalog.js";

describe("SaaS billing catalog", () => {
  it("publishes the four ordered packages and a 14-day trial", () => {
    expect(saasPlans.map((plan) => plan.id)).toEqual(["bronze", "silver", "gold", "platinum"]);
    expect(trialPeriodDays).toBe(14);
  });

  it("prices annual billing at ten monthly payments", () => {
    for (const plan of saasPlans) {
      expect(priceForCycle(plan, "annual")).toBe(plan.monthlyPriceLkr * 10);
      expect(plan.annualPriceLkr).toBeLessThan(plan.monthlyPriceLkr * 12);
    }
  });

  it("keeps limits monotonic as packages increase", () => {
    for (let index = 1; index < saasPlans.length; index++) {
      const previous = saasPlans[index - 1];
      const current = saasPlans[index];
      expect(current?.limits.employees).toBeGreaterThan(previous?.limits.employees ?? 0);
      expect(current?.limits.devices).toBeGreaterThan(previous?.limits.devices ?? 0);
    }
    expect(planById("platinum").limits.branches).toBeNull();
  });

  it("uses stable product configuration keys", () => {
    expect(billingProductKey("silver", "annual")).toBe("silver_annual");
  });
});
