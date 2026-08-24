import { Timestamp, type CollectionReference, type Firestore, type Query, type Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

import type { PlanLimits } from "./catalog.js";

export type AccessStatus = "active" | "restricted";

export interface SubscriptionEntitlement {
  accessStatus: AccessStatus;
  limits: PlanLimits;
}

function validLimit(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function entitlementFromData(data: FirebaseFirestore.DocumentData | undefined): SubscriptionEntitlement | null {
  if (data === undefined || (data.accessStatus !== "active" && data.accessStatus !== "restricted")) return null;
  const endsAt = data.endsAt;
  if (endsAt instanceof Timestamp && endsAt.toMillis() <= Date.now()) {
    return { accessStatus: "restricted", limits: { employees: 0, devices: 0, branches: 0, adminUsers: 0, historyYears: 0 } };
  }
  const limits = data.limits as Record<string, unknown> | undefined;
  if (limits === undefined || !validLimit(limits.employees) || limits.employees === null ||
      !validLimit(limits.devices) || limits.devices === null || !validLimit(limits.branches) ||
      !validLimit(limits.adminUsers) || limits.adminUsers === null ||
      !validLimit(limits.historyYears) || limits.historyYears === null) return null;
  return {
    accessStatus: data.accessStatus,
    limits: {
      employees: limits.employees,
      devices: limits.devices,
      branches: limits.branches,
      adminUsers: limits.adminUsers,
      historyYears: limits.historyYears,
    },
  };
}

function assertActive(entitlement: SubscriptionEntitlement | null): SubscriptionEntitlement {
  if (entitlement === null || entitlement.accessStatus !== "active") {
    throw new HttpsError("failed-precondition", "An active Infact Pulse subscription is required");
  }
  return entitlement;
}

export async function requireActiveSubscription(db: Firestore, organizationId: string): Promise<SubscriptionEntitlement> {
  const snapshot = await db.doc(`organizations/${organizationId}/subscription/current`).get();
  return assertActive(entitlementFromData(snapshot.data()));
}

export async function assertCreationWithinLimit(
  transaction: Transaction,
  db: Firestore,
  organizationId: string,
  resource: "employees" | "devices" | "branches",
  query: Query | CollectionReference,
): Promise<void> {
  const subscription = db.doc(`organizations/${organizationId}/subscription/current`);
  const [subscriptionSnapshot, resourceSnapshot] = await Promise.all([
    transaction.get(subscription),
    transaction.get(query),
  ]);
  const entitlement = assertActive(entitlementFromData(subscriptionSnapshot.data()));
  const limit = entitlement.limits[resource];
  if (limit !== null && resourceSnapshot.size >= limit) {
    throw new HttpsError("resource-exhausted", `Your package allows up to ${limit} active ${resource}`);
  }
}
