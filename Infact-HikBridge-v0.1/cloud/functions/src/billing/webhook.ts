import { createHash } from "node:crypto";

import type { Subscription } from "dodopayments/resources/subscriptions";
import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onRequest } from "firebase-functions/v2/https";

import { firestore } from "../firebase.js";
import {
  billingCycles,
  planById,
  planIds,
  priceForCycle,
  type BillingCycle,
  type PlanId,
} from "./catalog.js";
import { dodoApiKey, dodoClient, dodoWebhookKey } from "./config.js";

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (planIds as readonly string[]).includes(value);
}

function isBillingCycle(value: unknown): value is BillingCycle {
  return typeof value === "string" && (billingCycles as readonly string[]).includes(value);
}

function safeDocumentId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function timestamp(value: string | null | undefined): Timestamp | null {
  if (value === undefined || value === null) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : Timestamp.fromMillis(millis);
}

function accessForStatus(status: Subscription["status"]): "active" | "restricted" {
  return status === "active" ? "active" : "restricted";
}

async function resolveTenant(subscription: Subscription): Promise<{
  organizationId: string;
  planId: PlanId;
  billingCycle: BillingCycle;
} | null> {
  const metadataOrganization = stringValue(subscription.metadata.organization_id);
  const metadataPlan = subscription.metadata.plan_id;
  const metadataCycle = subscription.metadata.billing_cycle;
  const [providerMapping, productLookup] = await Promise.all([
    firestore.doc(`billingProviderSubscriptions/${safeDocumentId(subscription.subscription_id)}`).get(),
    firestore.doc(`billingProductLookup/${safeDocumentId(subscription.product_id)}`).get(),
  ]);
  const mappedOrganization = stringValue(providerMapping.get("organizationId"));
  const mappedPlan = providerMapping.get("planId");
  const mappedCycle = providerMapping.get("billingCycle");
  const mappedProductId = stringValue(providerMapping.get("providerProductId"));
  const lookupPlan = productLookup.get("planId");
  const lookupCycle = productLookup.get("billingCycle");
  const organizationId = metadataOrganization ?? mappedOrganization;
  if (organizationId !== null && isPlanId(lookupPlan) && isBillingCycle(lookupCycle)) {
    return { organizationId, planId: lookupPlan, billingCycle: lookupCycle };
  }
  if (organizationId !== null && isPlanId(metadataPlan) && isBillingCycle(metadataCycle)) {
    if (mappedProductId !== null && mappedProductId !== subscription.product_id) return null;
    return { organizationId, planId: metadataPlan, billingCycle: metadataCycle };
  }
  if (organizationId !== null && isPlanId(mappedPlan) && isBillingCycle(mappedCycle)) {
    return { organizationId, planId: mappedPlan, billingCycle: mappedCycle };
  }
  return null;
}

export const dodoPaymentsWebhook = onRequest({
  region: "asia-south1",
  secrets: [dodoApiKey, dodoWebhookKey],
  timeoutSeconds: 30,
  memory: "256MiB",
  maxInstances: 20,
  concurrency: 20,
  invoker: "public",
}, async (request, response) => {
  response.set("Cache-Control", "no-store");
  if (request.method !== "POST") {
    response.set("Allow", "POST");
    response.status(405).json({ error: "method_not_allowed" });
    return;
  }
  const webhookId = request.get("webhook-id");
  const webhookSignature = request.get("webhook-signature");
  const webhookTimestamp = request.get("webhook-timestamp");
  if (webhookId === undefined || webhookSignature === undefined || webhookTimestamp === undefined) {
    response.status(400).json({ error: "missing_webhook_headers" });
    return;
  }

  let event;
  try {
    event = dodoClient(true).webhooks.unwrap(request.rawBody.toString("utf8"), {
      headers: {
        "webhook-id": webhookId,
        "webhook-signature": webhookSignature,
        "webhook-timestamp": webhookTimestamp,
      },
    });
  } catch (error) {
    logger.warn("dodo_webhook_signature_rejected", { webhookId, error });
    response.status(400).json({ error: "invalid_signature" });
    return;
  }

  if (!event.type.startsWith("subscription.")) {
    response.status(200).json({ received: true, handled: false });
    return;
  }
  const subscription = event.data as Subscription;
  const tenant = await resolveTenant(subscription);
  if (tenant === null || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(tenant.organizationId)) {
    logger.error("dodo_webhook_tenant_unresolved", {
      webhookId,
      eventType: event.type,
      subscriptionId: subscription.subscription_id,
    });
    response.status(422).json({ error: "tenant_unresolved" });
    return;
  }

  const organization = firestore.doc(`organizations/${tenant.organizationId}`);
  const organizationSnapshot = await organization.get();
  if (!organizationSnapshot.exists) {
    logger.error("dodo_webhook_organization_missing", { webhookId, organizationId: tenant.organizationId });
    response.status(422).json({ error: "organization_missing" });
    return;
  }
  const plan = planById(tenant.planId);
  const now = Timestamp.now();
  const eventAt = timestamp(event.timestamp) ?? now;
  const projection = {
    organizationId: tenant.organizationId,
    organizationName: stringValue(organizationSnapshot.get("name")) ?? tenant.organizationId,
    planId: plan.id,
    planName: plan.name,
    billingCycle: tenant.billingCycle,
    billingStatus: subscription.status,
    accessStatus: accessForStatus(subscription.status),
    source: "dodo",
    currency: subscription.currency,
    priceLkr: priceForCycle(plan, tenant.billingCycle),
    providerPriceMinor: subscription.recurring_pre_tax_amount,
    limits: plan.limits,
    startsAt: timestamp(subscription.created_at),
    endsAt: timestamp(subscription.expires_at),
    currentPeriodStart: timestamp(subscription.previous_billing_date),
    currentPeriodEnd: timestamp(subscription.next_billing_date),
    pausedAt: timestamp(subscription.paused_at),
    cancelledAt: timestamp(subscription.cancelled_at),
    cancelAtPeriodEnd: subscription.cancel_at_next_billing_date,
    providerCustomerId: subscription.customer.customer_id,
    providerSubscriptionId: subscription.subscription_id,
    providerProductId: subscription.product_id,
    trialPeriodDays: subscription.trial_period_days,
    providerEventType: event.type,
    providerEventAt: eventAt,
    updatedAt: now,
  };

  const eventReference = firestore.doc(`billingWebhookEvents/${safeDocumentId(webhookId)}`);
  const globalReference = firestore.doc(`saasSubscriptions/${tenant.organizationId}`);
  const tenantReference = organization.collection("subscription").doc("current");
  const providerReference = firestore.doc(`billingProviderSubscriptions/${safeDocumentId(subscription.subscription_id)}`);
  const accountReference = firestore.doc(`billingAccounts/${tenant.organizationId}`);
  const applied = await firestore.runTransaction(async (transaction) => {
    const [eventSnapshot, globalSnapshot] = await Promise.all([
      transaction.get(eventReference),
      transaction.get(globalReference),
    ]);
    if (eventSnapshot.exists) return false;
    const previousEventAt = globalSnapshot.get("providerEventAt");
    const stale = previousEventAt instanceof Timestamp && previousEventAt.toMillis() > eventAt.toMillis();
    transaction.create(eventReference, {
      webhookId,
      eventType: event.type,
      subscriptionId: subscription.subscription_id,
      organizationId: tenant.organizationId,
      receivedAt: now,
      eventAt,
      applied: !stale,
    });
    if (stale) return false;
    transaction.set(globalReference, projection, { merge: true });
    const { organizationName: _organizationName, ...tenantProjection } = projection;
    transaction.set(tenantReference, tenantProjection, { merge: true });
    transaction.set(providerReference, {
      organizationId: tenant.organizationId,
      planId: tenant.planId,
      billingCycle: tenant.billingCycle,
      providerSubscriptionId: subscription.subscription_id,
      providerProductId: subscription.product_id,
      updatedAt: now,
    }, { merge: true });
    transaction.set(accountReference, {
      organizationId: tenant.organizationId,
      providerCustomerId: subscription.customer.customer_id,
      ...(subscription.trial_period_days > 0 && subscription.status === "active" ? { trialConsumedAt: now } : {}),
      updatedAt: now,
    }, { merge: true });
    return true;
  });

  logger.info("dodo_subscription_webhook_processed", {
    webhookId,
    eventType: event.type,
    organizationId: tenant.organizationId,
    subscriptionId: subscription.subscription_id,
    applied,
  });
  response.status(200).json({ received: true, handled: true, applied });
});
