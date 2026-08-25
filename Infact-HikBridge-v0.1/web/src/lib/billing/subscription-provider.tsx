"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { useAuth, type AppUser } from "@/lib/auth/auth-provider";
import { getCurrentSubscription, type CurrentSubscriptionPayload } from "@/lib/firebase/actions";

export type SubscriptionSnapshot = CurrentSubscriptionPayload;

interface SubscriptionValue {
  subscription: SubscriptionSnapshot | null;
  loading: boolean;
  error: string | null;
}

const SubscriptionContext = createContext<SubscriptionValue | null>(null);

function retryDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const demoSubscription: SubscriptionSnapshot = {
  organizationId: "demo-organization",
  planId: "silver",
  planName: "Silver",
  billingCycle: "monthly",
  billingStatus: "active",
  accessStatus: "active",
  source: "complimentary",
  currency: "LKR",
  priceLkr: 9_900,
  limits: { employees: 100, devices: 3, branches: 3, adminUsers: 10, historyYears: 2 },
  currentPeriodEnd: null,
  endsAt: null,
  cancelAtPeriodEnd: false,
};

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading, demo } = useAuth();
  const [subscription, setSubscription] = useState<SubscriptionSnapshot | null>(null);
  const [loadedUser, setLoadedUser] = useState<AppUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (demo || authLoading) return;
    if (user === null || user.organizationId === null) {
      return;
    }
    const currentUser = user;
    let active = true;
    async function loadSubscription() {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await getCurrentSubscription();
          if (!active) return;
          if (result.organizationId !== currentUser.organizationId) {
            throw new Error("The authenticated organization changed while access was loading");
          }
          setSubscription(result.subscription);
          setLoadedUser(currentUser);
          setError(null);
          return;
        } catch (loadError: unknown) {
          if (!active) return;
          if (attempt < 2) {
            await retryDelay(750 * (attempt + 1));
            continue;
          }
          setError(loadError instanceof Error ? loadError.message : "Subscription access could not be loaded");
          setLoadedUser(currentUser);
        }
      }
    }
    void loadSubscription();
    return () => { active = false; };
  }, [authLoading, demo, user]);

  const organizationId = user?.organizationId ?? null;
  const serverConfirmed = user !== null && organizationId !== null && loadedUser === user;
  const resolvedSubscription = demo ? demoSubscription : serverConfirmed ? subscription : null;
  const loading = demo ? false : authLoading || (organizationId !== null && !serverConfirmed);
  const resolvedError = demo || !serverConfirmed ? null : error;
  const value = useMemo(() => ({ subscription: resolvedSubscription, loading, error: resolvedError }), [loading, resolvedError, resolvedSubscription]);
  return <SubscriptionContext.Provider value={value}>{children}</SubscriptionContext.Provider>;
}

export function useSubscription(): SubscriptionValue {
  const value = useContext(SubscriptionContext);
  if (value === null) throw new Error("useSubscription must be used inside SubscriptionProvider");
  return value;
}
