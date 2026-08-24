import DodoPayments from "dodopayments";
import { defineSecret, defineString } from "firebase-functions/params";

export const dodoApiKey = defineSecret("DODO_PAYMENTS_API_KEY");
export const dodoWebhookKey = defineSecret("DODO_PAYMENTS_WEBHOOK_KEY");
export const dodoEnvironment = defineString("DODO_PAYMENTS_ENVIRONMENT", { default: "test_mode" });
export const saasPublicUrl = defineString("SAAS_PUBLIC_URL", { default: "http://localhost:3000" });

function environment(): "test_mode" | "live_mode" {
  const value = dodoEnvironment.value();
  if (value !== "test_mode" && value !== "live_mode") {
    throw new Error("DODO_PAYMENTS_ENVIRONMENT must be test_mode or live_mode");
  }
  return value;
}

export function dodoClient(includeWebhookKey = false): DodoPayments {
  return new DodoPayments({
    bearerToken: dodoApiKey.value(),
    environment: environment(),
    ...(includeWebhookKey ? { webhookKey: dodoWebhookKey.value() } : {}),
  });
}

export function publicSiteUrl(): string {
  return saasPublicUrl.value().replace(/\/$/, "");
}
