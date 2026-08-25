import { createHash, randomUUID } from "node:crypto";

import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

import { requireAuthentication, requireOrganizationRole, type AuthContext } from "../authz.js";
import { firestore } from "../firebase.js";
import {
  billingCycles,
  billingProductKey,
  planById,
  planIds,
  priceForCycle,
  saasPlans,
  trialPeriodDays,
  type BillingCycle,
  type PlanId,
} from "./catalog.js";
import { dodoApiKey, dodoClient, publicSiteUrl } from "./config.js";

const organizationIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const planIdSchema = z.enum(planIds);
const billingCycleSchema = z.enum(billingCycles);

const checkoutSchema = z.object({
  organizationId: organizationIdSchema,
  planId: planIdSchema,
  billingCycle: billingCycleSchema,
}).strict();

const organizationSchema = z.object({ organizationId: organizationIdSchema }).strict();

const configureProductSchema = z.object({
  planId: planIdSchema,
  billingCycle: billingCycleSchema,
  dodoProductId: z.string().trim().min(3).max(200),
  enabled: z.boolean(),
}).strict();

const subscriptionActionSchema = z.object({
  organizationId: organizationIdSchema,
  action: z.enum(["pause", "resume", "cancel"]),
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

function productLookupId(productId: string): string {
  return createHash("sha256").update(productId, "utf8").digest("hex");
}

function publicPlan(planId: PlanId, availability: { monthly: boolean; annual: boolean }) {
  const plan = planById(planId);
  return { ...plan, trialPeriodDays, currency: "LKR" as const, availability };
}

export const getSaasCatalog = onCall({ region: "asia-south1" }, async () => {
  const snapshots = await firestore.getAll(...saasPlans.map((plan) => firestore.doc(`saasPlans/${plan.id}`)));
  return saasPlans.map((plan, index) => {
    const availability = snapshots[index]?.get("availability") as Record<string, unknown> | undefined;
    return publicPlan(plan.id, {
      monthly: availability?.monthly === true,
      annual: availability?.annual === true,
    });
  });
});

export const configureBillingProduct = onCall({ region: "asia-south1" }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  requirePlatformAdmin(auth);
  const parsed = configureProductSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Billing product fields are invalid");
  const input = parsed.data;
  const plan = planById(input.planId);
  const key = billingProductKey(input.planId, input.billingCycle);
  const config = firestore.doc(`billingPlanConfig/${key}`);
  const lookup = firestore.doc(`billingProductLookup/${productLookupId(input.dodoProductId)}`);
  const publicReference = firestore.doc(`saasPlans/${input.planId}`);
  const audit = firestore.collection("platformBillingAudits").doc();
  const now = Timestamp.now();

  await firestore.runTransaction(async (transaction) => {
    const publicSnapshot = await transaction.get(publicReference);
    const storedAvailability = publicSnapshot.get("availability") as Record<string, unknown> | undefined;
    const availability = {
      monthly: storedAvailability?.monthly === true,
      annual: storedAvailability?.annual === true,
      [input.billingCycle]: input.enabled,
    };
    transaction.set(config, {
      planId: input.planId,
      billingCycle: input.billingCycle,
      dodoProductId: input.dodoProductId,
      enabled: input.enabled,
      updatedAt: now,
      updatedBy: auth.uid,
    }, { merge: true });
    transaction.set(lookup, {
      dodoProductId: input.dodoProductId,
      planId: input.planId,
      billingCycle: input.billingCycle,
      enabled: input.enabled,
      updatedAt: now,
    });
    transaction.set(publicReference, {
      ...publicPlan(input.planId, availability),
      updatedAt: now,
    });
    transaction.create(audit, {
      action: "billing_product_configured",
      planId: input.planId,
      billingCycle: input.billingCycle,
      dodoProductId: input.dodoProductId,
      enabled: input.enabled,
      actorId: auth.uid,
      createdAt: now,
    });
  });
  logger.info("billing_product_configured", { planId: plan.id, billingCycle: input.billingCycle, uid: auth.uid });
  return { planId: input.planId, billingCycle: input.billingCycle, enabled: input.enabled };
});

export const createSubscriptionCheckout = onCall({
  region: "asia-south1",
  secrets: [dodoApiKey],
  timeoutSeconds: 30,
}, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const parsed = checkoutSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Checkout selection is invalid");
  const input = parsed.data;
  await requireOrganizationRole(firestore, auth, input.organizationId, ["organizationOwner"], { subscriptionRequired: false });

  const organization = firestore.doc(`organizations/${input.organizationId}`);
  const subscription = organization.collection("subscription").doc("current");
  const account = firestore.doc(`billingAccounts/${input.organizationId}`);
  const config = firestore.doc(`billingPlanConfig/${billingProductKey(input.planId, input.billingCycle)}`);
  const lock = firestore.doc(`billingCheckoutSessions/${input.organizationId}`);
  const email = stringField(auth.token.email);
  if (email === null) throw new HttpsError("failed-precondition", "Your account needs an email address for checkout");
  const plan = planById(input.planId);
  const requestId = randomUUID();
  const acquisition = await firestore.runTransaction(async (transaction) => {
    const [organizationSnapshot, subscriptionSnapshot, accountSnapshot, configSnapshot, lockSnapshot] = await transaction.getAll(
      organization, subscription, account, config, lock,
    );
    if (organizationSnapshot === undefined || subscriptionSnapshot === undefined || accountSnapshot === undefined ||
        configSnapshot === undefined || lockSnapshot === undefined) {
      throw new Error("Checkout transaction did not return every requested document");
    }
    if (!organizationSnapshot.exists) throw new HttpsError("not-found", "Organization does not exist");
    const existingBillingStatus = subscriptionSnapshot.get("billingStatus");
    if (subscriptionSnapshot.get("accessStatus") === "active" ||
        (subscriptionSnapshot.get("source") === "dodo" && ["pending", "active", "on_hold", "paused"].includes(existingBillingStatus))) {
      throw new HttpsError("already-exists", "This organization already has an active or pending subscription");
    }
    const existingUrl = stringField(lockSnapshot.get("checkoutUrl"));
    const expiresAt = lockSnapshot.get("expiresAt");
    if (existingUrl !== null && expiresAt instanceof Timestamp && expiresAt.toMillis() > Date.now()) {
      return { kind: "reuse" as const, checkoutUrl: existingUrl };
    }
    if (lockSnapshot.get("state") === "creating" && expiresAt instanceof Timestamp && expiresAt.toMillis() > Date.now()) {
      throw new HttpsError("aborted", "A checkout is already being prepared. Please wait a moment and try again.");
    }
    const productId = stringField(configSnapshot.get("dodoProductId"));
    if (!configSnapshot.exists || configSnapshot.get("enabled") !== true || productId === null) {
      throw new HttpsError("failed-precondition", "This package and billing cycle are not available for checkout yet");
    }
    const trialDays = accountSnapshot.get("trialConsumedAt") instanceof Timestamp ? 0 : trialPeriodDays;
    const now = Timestamp.now();
    transaction.set(lock, {
      organizationId: input.organizationId,
      state: "creating",
      requestId,
      planId: input.planId,
      billingCycle: input.billingCycle,
      createdAt: now,
      createdBy: auth.uid,
      expiresAt: Timestamp.fromMillis(now.toMillis() + 2 * 60 * 1000),
    });
    return {
      kind: "create" as const,
      productId,
      trialDays,
      customerName: stringField(auth.token.name) ?? stringField(organizationSnapshot.get("name")) ?? "Organization Owner",
    };
  });
  if (acquisition.kind === "reuse") return { checkoutUrl: acquisition.checkoutUrl, reused: true };
  const { productId, trialDays, customerName } = acquisition;

  try {
    const checkout = await dodoClient().checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      billing_currency: "LKR",
      customer: {
        email,
        name: customerName,
      },
      return_url: `${publicSiteUrl()}/subscribe/success`,
      cancel_url: `${publicSiteUrl()}/subscribe?cancelled=1`,
      metadata: {
        organization_id: input.organizationId,
        user_id: auth.uid,
        plan_id: input.planId,
        billing_cycle: input.billingCycle,
      },
      subscription_data: { trial_period_days: trialDays },
      feature_flags: {
        allow_currency_selection: false,
        allow_discount_code: true,
        allow_phone_number_collection: true,
      },
    }, { idempotencyKey: requestId });
    if (checkout.checkout_url === undefined || checkout.checkout_url === null) {
      throw new Error("Dodo checkout session did not return a hosted URL");
    }
    await lock.set({
      state: "ready",
      checkoutSessionId: checkout.session_id,
      checkoutUrl: checkout.checkout_url,
      trialDays,
      updatedAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(Date.now() + 15 * 60 * 1000),
    }, { merge: true });
    logger.info("subscription_checkout_created", {
      organizationId: input.organizationId,
      planId: plan.id,
      billingCycle: input.billingCycle,
      trialDays,
    });
    return { checkoutUrl: checkout.checkout_url, reused: false };
  } catch (error) {
    await lock.set({ state: "failed", failedAt: Timestamp.now(), expiresAt: Timestamp.now() }, { merge: true });
    logger.error("subscription_checkout_failed", { organizationId: input.organizationId, error });
    throw new HttpsError("internal", "Dodo checkout could not be created. Please try again.");
  }
});

export const createCustomerPortalSession = onCall({
  region: "asia-south1",
  secrets: [dodoApiKey],
}, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const parsed = organizationSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Organization is invalid");
  await requireOrganizationRole(firestore, auth, parsed.data.organizationId, ["organizationOwner"], { subscriptionRequired: false });
  const subscription = await firestore.doc(`saasSubscriptions/${parsed.data.organizationId}`).get();
  const customerId = stringField(subscription.get("providerCustomerId"));
  if (subscription.get("source") !== "dodo" || customerId === null) {
    throw new HttpsError("failed-precondition", "This subscription is managed manually and has no payment portal");
  }
  const portal = await dodoClient().customers.customerPortal.create(customerId, {
    return_url: `${publicSiteUrl()}/billing`,
  });
  return { portalUrl: portal.link };
});

export const setSubscriptionStatus = onCall({
  region: "asia-south1",
  secrets: [dodoApiKey],
}, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  requirePlatformAdmin(auth);
  const parsed = subscriptionActionSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Subscription action is invalid");
  const input = parsed.data;
  const globalReference = firestore.doc(`saasSubscriptions/${input.organizationId}`);
  const tenantReference = firestore.doc(`organizations/${input.organizationId}/subscription/current`);
  const snapshot = await globalReference.get();
  if (!snapshot.exists) throw new HttpsError("not-found", "Subscription does not exist");
  const source = snapshot.get("source");
  const providerSubscriptionId = stringField(snapshot.get("providerSubscriptionId"));
  const providerStatus = input.action === "pause" ? "paused" : input.action === "resume" ? "active" : "cancelled";
  if (source === "dodo") {
    if (providerSubscriptionId === null) throw new HttpsError("failed-precondition", "Dodo subscription ID is missing");
    await dodoClient().subscriptions.update(providerSubscriptionId, { status: providerStatus });
  }
  const now = Timestamp.now();
  const accessStatus = input.action === "resume" ? "active" : "restricted";
  const updates = {
    billingStatus: providerStatus,
    accessStatus,
    statusReason: input.reason,
    updatedAt: now,
    updatedBy: auth.uid,
  };
  const batch = firestore.batch();
  batch.set(globalReference, updates, { merge: true });
  batch.set(tenantReference, updates, { merge: true });
  batch.create(firestore.collection("platformBillingAudits").doc(), {
    action: `subscription_${input.action}`,
    organizationId: input.organizationId,
    source,
    reason: input.reason,
    actorId: auth.uid,
    createdAt: now,
  });
  await batch.commit();
  return { organizationId: input.organizationId, billingStatus: providerStatus, accessStatus };
});
