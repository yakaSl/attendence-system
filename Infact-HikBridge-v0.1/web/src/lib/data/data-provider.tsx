"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { useAuth } from "@/lib/auth/auth-provider";
import { firebaseFirestore, isDemoMode } from "@/lib/firebase/client";
import { demoRepository, firestoreRepository, type AttendanceRepository } from "./repository";
import type { Organization } from "./types";

interface DataValue {
  repository: AttendanceRepository;
  organization: Organization | null;
  loading: boolean;
  error: string | null;
  refreshOrganization(): void;
}

const DataContext = createContext<DataValue | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const repository = useMemo(
    () => isDemoMode() ? demoRepository : firestoreRepository(firebaseFirestore()),
    [],
  );
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    if (user === null) {
      return;
    }
    if (user.organizationId === null) {
      return;
    }
    repository.getOrganization(user.organizationId).then((value) => {
      if (active) setOrganization(value);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "Organization could not be loaded");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [repository, user, version]);

  const value = useMemo<DataValue>(() => ({
    repository,
    organization,
    loading,
    error,
    refreshOrganization: () => { setLoading(true); setError(null); setVersion((current) => current + 1); },
  }), [error, loading, organization, repository]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataValue {
  const value = useContext(DataContext);
  if (value === null) throw new Error("useData must be used inside DataProvider");
  return value;
}
