"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/lib/auth/auth-provider";
import { ErrorState, LoadingState } from "./ui";

export function AccountGuard({ children, platformAdmin = false }: { children: ReactNode; platformAdmin?: boolean }) {
  const { user, onboardingRequired, loading, error } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (onboardingRequired) router.replace("/onboarding");
    else if (user === null && error === null) router.replace("/login");
    else if (platformAdmin && user?.role !== "platformAdmin") router.replace("/dashboard");
  }, [error, loading, onboardingRequired, platformAdmin, router, user]);

  if (loading) return <main className="centered-state"><LoadingState label="Checking account" /></main>;
  if (error) return <main className="centered-state"><ErrorState message={error} /></main>;
  if (user === null || onboardingRequired || (platformAdmin && user.role !== "platformAdmin")) {
    return <main className="centered-state"><LoadingState label="Opening account" /></main>;
  }
  return children;
}
