"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/lib/auth/auth-provider";
import { useSubscription } from "@/lib/billing/subscription-provider";
import { ErrorState, LoadingState } from "./ui";

export function ProtectedApp({ children }: { children: ReactNode }) {
  const { user, onboardingRequired, loading, error } = useAuth();
  const { subscription, loading: subscriptionLoading, error: subscriptionError } = useSubscription();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (onboardingRequired) router.replace("/onboarding");
    else if (user === null && error === null) router.replace("/login");
    else if (user?.organizationId === null) router.replace("/platform");
    else if (user !== null && user.role !== "platformAdmin" && !subscriptionLoading && subscription?.accessStatus !== "active") router.replace("/subscribe");
  }, [error, loading, onboardingRequired, router, subscription, subscriptionLoading, user]);

  if (loading) return <main className="centered-state"><LoadingState /></main>;
  if (error) return <main className="centered-state"><ErrorState message={error} /></main>;
  if (onboardingRequired) return <main className="centered-state"><LoadingState label="Opening organization setup" /></main>;
  if (user === null) return <main className="centered-state"><LoadingState label="Opening sign in" /></main>;
  if (user.organizationId === null) return <main className="centered-state"><LoadingState label="Opening platform operations" /></main>;
  if (subscriptionLoading) return <main className="centered-state"><LoadingState label="Checking subscription" /></main>;
  if (subscriptionError) return <main className="centered-state"><ErrorState message={subscriptionError} /></main>;
  if (user.role !== "platformAdmin" && subscription?.accessStatus !== "active") {
    return <main className="centered-state"><LoadingState label="Opening package selection" /></main>;
  }
  return children;
}
