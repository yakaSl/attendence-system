"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/lib/auth/auth-provider";
import { ErrorState, LoadingState } from "./ui";

export function ProtectedApp({ children }: { children: ReactNode }) {
  const { user, onboardingRequired, loading, error } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (onboardingRequired) router.replace("/onboarding");
    else if (user === null && error === null) router.replace("/login");
  }, [error, loading, onboardingRequired, router, user]);

  if (loading) return <main className="centered-state"><LoadingState /></main>;
  if (error) return <main className="centered-state"><ErrorState message={error} /></main>;
  if (onboardingRequired) return <main className="centered-state"><LoadingState label="Opening organization setup" /></main>;
  if (user === null) return <main className="centered-state"><LoadingState label="Opening sign in" /></main>;
  return children;
}
