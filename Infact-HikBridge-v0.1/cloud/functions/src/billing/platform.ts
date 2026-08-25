import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

import { requireAuthentication, type AuthContext } from "../authz.js";
import { firestore } from "../firebase.js";
import { billingCycles, planById, planIds, priceForCycle } from "./catalog.js";

const organizationIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const manualActivationSchema = z.object({
  organizationId: organizationIdSchema,
  planId: z.enum(planIds),
  billingCycle: z.enum(billingCycles),
  startsAt: z.iso.datetime({ offset: true }).optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  reason: z.string().trim().min(5).max(500),
}).strict();

function requirePlatformAdmin(auth: AuthContext): void {
  if (auth.token.platformAdmin !== true) {
    throw new HttpsError("permission-denied", "Platform administrator access is required");
  }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isoField(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  return stringField(value);
}

export const activateManualSubscription = onCall({
  region: "asia-south1",
  invoker: "public",
}, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  requirePlatformAdmin(auth);
  const parsed = manualActivationSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Manual subscription fields are invalid");
  const input = parsed.data;
  const organization = firestore.doc(`organizations/${input.organizationId}`);
  const [organizationSnapshot, existingSubscription] = await Promise.all([
    organization.get(),
    firestore.doc(`saasSubscriptions/${input.organizationId}`).get(),
  ]);
  if (!organizationSnapshot.exists) throw new HttpsError("not-found", "Organization does not exist");
  if (existingSubscription.get("source") === "dodo" &&
      ["pending", "active", "on_hold", "paused"].includes(existingSubscription.get("billingStatus"))) {
    throw new HttpsError("failed-precondition", "Cancel the Dodo subscription before replacing it with a manual term");
  }
  const plan = planById(input.planId);
  const startsAt = input.startsAt === undefined ? Timestamp.now() : Timestamp.fromDate(new Date(input.startsAt));
  const endsAt = input.endsAt === undefined || input.endsAt === null ? null : Timestamp.fromDate(new Date(input.endsAt));
  if (endsAt !== null && endsAt.toMillis() <= Date.now()) {
    throw new HttpsError("invalid-argument", "Manual subscription end must be in the future");
  }
  const now = Timestamp.now();
  const projection = {
    organizationId: input.organizationId,
    planId: plan.id,
    planName: plan.name,
    billingCycle: input.billingCycle,
    billingStatus: "active",
    accessStatus: "active",
    source: "manual",
    currency: "LKR",
    priceLkr: priceForCycle(plan, input.billingCycle),
    limits: plan.limits,
    startsAt,
    endsAt,
    providerCustomerId: null,
    providerSubscriptionId: null,
    cancelAtPeriodEnd: false,
    updatedAt: now,
    updatedBy: auth.uid,
  };
  const batch = firestore.batch();
  batch.set(organization.collection("subscription").doc("current"), projection);
  batch.set(firestore.doc(`saasSubscriptions/${input.organizationId}`), {
    ...projection,
    organizationName: stringField(organizationSnapshot.get("name")) ?? input.organizationId,
  });
  batch.create(firestore.collection("platformBillingAudits").doc(), {
    action: "manual_subscription_activated",
    organizationId: input.organizationId,
    planId: input.planId,
    billingCycle: input.billingCycle,
    startsAt,
    endsAt,
    reason: input.reason,
    actorId: auth.uid,
    createdAt: now,
  });
  await batch.commit();
  return { organizationId: input.organizationId, accessStatus: "active" as const };
});

export const listPlatformSubscriptions = onCall({
  region: "asia-south1",
  invoker: "public",
}, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  requirePlatformAdmin(auth);
  const snapshots = await firestore.collection("saasSubscriptions").limit(250).get();
  return {
    subscriptions: snapshots.docs.map((snapshot) => {
      const data = snapshot.data();
      const endsAt = isoField(data.endsAt);
      const expired = endsAt !== null && Date.parse(endsAt) <= Date.now();
      return {
        organizationId: snapshot.id,
        organizationName: stringField(data.organizationName) ?? snapshot.id,
        planId: stringField(data.planId),
        planName: stringField(data.planName),
        billingCycle: stringField(data.billingCycle),
        billingStatus: stringField(data.billingStatus),
        accessStatus: expired ? "restricted" : stringField(data.accessStatus),
        source: stringField(data.source),
        startsAt: isoField(data.startsAt),
        endsAt,
        currentPeriodEnd: isoField(data.currentPeriodEnd),
        updatedAt: isoField(data.updatedAt),
      };
    }),
  };
});
