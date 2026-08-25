"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createUserWithEmailAndPassword, onIdTokenChanged, signInWithEmailAndPassword, signOut, updateProfile, type User as FirebaseUser } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

import { firebaseAuth, firebaseFirestore, isDemoMode } from "@/lib/firebase/client";
import type { OrganizationRole } from "@/lib/data/types";

export interface AppUser {
  uid: string;
  email: string;
  displayName: string;
  organizationId: string | null;
  role: OrganizationRole;
}

export interface AuthIdentity {
  uid: string;
  email: string;
  displayName: string;
}

interface AuthValue {
  user: AppUser | null;
  identity: AuthIdentity | null;
  onboardingRequired: boolean;
  loading: boolean;
  error: string | null;
  demo: boolean;
  login(email: string, password: string): Promise<void>;
  signup(name: string, email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refreshProfile(): Promise<boolean>;
}

type ProfileResolution =
  | { status: "ready"; identity: AuthIdentity; user: AppUser }
  | { status: "onboarding"; identity: AuthIdentity };

const AuthContext = createContext<AuthValue | null>(null);

const demoUser: AppUser = {
  uid: "demo-hr-admin",
  email: "hr@infact.demo",
  displayName: "HR Manager",
  organizationId: "demo-organization",
  role: "hrAdmin",
};

const demoIdentity: AuthIdentity = {
  uid: demoUser.uid,
  email: demoUser.email,
  displayName: demoUser.displayName,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Authentication failed";
}

function identityFor(firebaseUser: FirebaseUser): AuthIdentity {
  return {
    uid: firebaseUser.uid,
    email: firebaseUser.email ?? "",
    displayName: firebaseUser.displayName || firebaseUser.email || "User",
  };
}

async function resolveProfile(firebaseUser: FirebaseUser): Promise<ProfileResolution> {
  const db = firebaseFirestore();
  const identity = identityFor(firebaseUser);
  const token = await firebaseUser.getIdTokenResult();
  const platformAdmin = token.claims.platformAdmin === true;
  const profile = await getDoc(doc(db, "users", firebaseUser.uid));
  const storedOrganizationId = profile.get("defaultOrganizationId");
  const organizationId = typeof storedOrganizationId === "string" && storedOrganizationId.length > 0 ? storedOrganizationId : null;

  if (platformAdmin) {
    return {
      status: "ready",
      identity,
      user: {
        uid: firebaseUser.uid,
        email: firebaseUser.email ?? "",
        displayName: profile.get("displayName") || identity.displayName,
        organizationId,
        role: "platformAdmin",
      },
    };
  }

  if (!profile.exists() || typeof organizationId !== "string" || organizationId.length === 0) {
    return { status: "onboarding", identity };
  }

  const membership = await getDoc(doc(db, "organizations", organizationId, "members", firebaseUser.uid));
  if (!membership.exists() || membership.get("active") !== true) {
    throw new Error("Your organization membership is not active");
  }
  const membershipRole = membership.get("role");
  const role: OrganizationRole = (["organizationOwner", "hrAdmin", "manager", "viewer"] as unknown[]).includes(membershipRole) ?
      membershipRole as OrganizationRole : "viewer";

  return {
    status: "ready",
    identity,
    user: {
      uid: firebaseUser.uid,
      email: firebaseUser.email ?? "",
      displayName: profile.get("displayName") || identity.displayName,
      organizationId,
      role,
    },
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const demo = isDemoMode();
  const [user, setUser] = useState<AppUser | null>(demo ? demoUser : null);
  const [identity, setIdentity] = useState<AuthIdentity | null>(demo ? demoIdentity : null);
  const [onboardingRequired, setOnboardingRequired] = useState(false);
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | null>(null);

  const applyResolution = useCallback((resolution: ProfileResolution) => {
    setIdentity(resolution.identity);
    if (resolution.status === "onboarding") {
      setUser(null);
      setOnboardingRequired(true);
      return;
    }
    setUser(resolution.user);
    setOnboardingRequired(false);
  }, []);

  const refreshProfile = useCallback(async (): Promise<boolean> => {
    if (demo) return true;
    const firebaseUser = firebaseAuth().currentUser;
    if (firebaseUser === null) {
      setUser(null);
      setIdentity(null);
      setOnboardingRequired(false);
      return false;
    }
    setLoading(true);
    setError(null);
    try {
      const resolution = await resolveProfile(firebaseUser);
      applyResolution(resolution);
      return resolution.status === "ready";
    } catch (loadError) {
      setUser(null);
      setOnboardingRequired(false);
      setError(message(loadError));
      return false;
    } finally {
      setLoading(false);
    }
  }, [applyResolution, demo]);

  useEffect(() => {
    if (demo) return;
    let active = true;
    const auth = firebaseAuth();
    const unsubscribe = onIdTokenChanged(auth, async (firebaseUser) => {
      if (!active) return;
      setLoading(true);
      setError(null);
      try {
        if (firebaseUser === null) {
          setUser(null);
          setIdentity(null);
          setOnboardingRequired(false);
          return;
        }
        const resolution = await resolveProfile(firebaseUser);
        if (active) applyResolution(resolution);
      } catch (loadError) {
        if (active) {
          setUser(null);
          setOnboardingRequired(false);
          setError(message(loadError));
        }
      } finally {
        if (active) setLoading(false);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [applyResolution, demo]);

  const value = useMemo<AuthValue>(() => ({
    user,
    identity,
    onboardingRequired,
    loading,
    error,
    demo,
    async login(email, password) {
      setError(null);
      if (demo) {
        setIdentity({ ...demoIdentity, email: email || demoIdentity.email });
        setUser({ ...demoUser, email: email || demoUser.email });
        return;
      }
      try {
        await signInWithEmailAndPassword(firebaseAuth(), email, password);
      } catch (loginError) {
        const safeMessage = message(loginError).replace(/Firebase:\s*/i, "");
        setError(safeMessage);
        throw loginError;
      }
    },
    async signup(name, email, password) {
      setError(null);
      if (demo) {
        setIdentity({ ...demoIdentity, displayName: name, email });
        setUser(null);
        setOnboardingRequired(true);
        return;
      }
      try {
        const credential = await createUserWithEmailAndPassword(firebaseAuth(), email, password);
        await updateProfile(credential.user, { displayName: name.trim() });
        await credential.user.getIdToken(true);
        applyResolution({ status: "onboarding", identity: identityFor(credential.user) });
      } catch (signupError) {
        setError(message(signupError).replace(/Firebase:\s*/i, ""));
        throw signupError;
      }
    },
    async logout() {
      if (demo) {
        setUser(null);
        setIdentity(null);
        return;
      }
      await signOut(firebaseAuth());
    },
    refreshProfile,
  }), [applyResolution, demo, error, identity, loading, onboardingRequired, refreshProfile, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
