import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { requireAuthentication, type AuthContext } from "../authz.js";
import { firestore } from "../firebase.js";
import { billingCycles, planIds } from "./catalog.js";

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isoField(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  return stringField(value);
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export const getCurrentSubscription = onCall({
  region: "asia-south1",
  invoker: "public",
}, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const profile = await firestore.doc(`users/${auth.uid}`).get();
  const organizationId = stringField(profile.get("defaultOrganizationId"));
  if (organizationId === null) return { organizationId: null, subscription: null };

  if (auth.token.platformAdmin !== true) {
    const membership = await firestore.doc(`organizations/${organizationId}/members/${auth.uid}`).get();
    if (!membership.exists || membership.get("active") !== true) {
      throw new HttpsError("permission-denied", "Your organization membership is not active");
    }
  }

  const subscription = await firestore.doc(`organizations/${organizationId}/subscription/current`).get();
  if (!subscription.exists) return { organizationId, subscription: null };
  const data = subscription.data() ?? {};
  const planId = stringField(data.planId);
  const planName = stringField(data.planName);
  const billingCycle = stringField(data.billingCycle);
  if (planId === null || !(planIds as readonly string[]).includes(planId) || planName === null ||
      billingCycle === null || !(billingCycles as readonly string[]).includes(billingCycle)) {
    throw new HttpsError("data-loss", "The organization subscription is incomplete");
  }
  const storedLimits = typeof data.limits === "object" && data.limits !== null ? data.limits as Record<string, unknown> : {};
  const endsAt = isoField(data.endsAt);
  const expired = endsAt !== null && Date.parse(endsAt) <= Date.now();
  const source = stringField(data.source);
  return {
    organizationId,
    subscription: {
      organizationId,
      planId,
      planName,
      billingCycle,
      billingStatus: stringField(data.billingStatus) ?? "unknown",
      accessStatus: data.accessStatus === "active" && !expired ? "active" : "restricted",
      source: source === "manual" || source === "complimentary" ? source : "dodo",
      currency: "LKR",
      priceLkr: numberField(data.priceLkr),
      limits: {
        employees: numberField(storedLimits.employees),
        devices: numberField(storedLimits.devices),
        branches: storedLimits.branches === null ? null : numberField(storedLimits.branches),
        adminUsers: numberField(storedLimits.adminUsers),
        historyYears: numberField(storedLimits.historyYears),
      },
      currentPeriodEnd: isoField(data.currentPeriodEnd),
      endsAt,
      cancelAtPeriodEnd: data.cancelAtPeriodEnd === true,
    },
  };
});
