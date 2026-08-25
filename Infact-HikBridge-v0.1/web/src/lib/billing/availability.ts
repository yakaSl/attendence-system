"use client";

import { collection, getDocs } from "firebase/firestore";
import { useEffect, useState } from "react";

import { firebaseFirestore } from "@/lib/firebase/client";
import { saasPlans, type BillingCycle, type PlanId } from "./catalog";

export type PlanAvailability = Record<PlanId, Record<BillingCycle, boolean>>;

const defaults = Object.fromEntries(saasPlans.map((plan) => [plan.id, { monthly: false, annual: false }])) as PlanAvailability;

export function usePlanAvailability(): PlanAvailability {
  const [availability, setAvailability] = useState(defaults);
  useEffect(() => {
    let active = true;
    void getDocs(collection(firebaseFirestore(), "saasPlans")).then((snapshot) => {
      if (!active || snapshot.empty) return;
      setAvailability((current) => {
        const next = { ...current };
        for (const document of snapshot.docs) {
          const plan = saasPlans.find((candidate) => candidate.id === document.id);
          if (plan === undefined) continue;
          const value = document.get("availability") as Record<string, unknown> | undefined;
          next[plan.id] = { monthly: value?.monthly === true, annual: value?.annual === true };
        }
        return next;
      });
    }).catch(() => {
      // Checkout remains fail-closed if Firebase is temporarily unreachable.
    });
    return () => { active = false; };
  }, []);
  return availability;
}
