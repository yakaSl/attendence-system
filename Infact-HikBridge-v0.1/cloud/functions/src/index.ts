import { logger } from "firebase-functions";
import { onRequest } from "firebase-functions/v2/https";

import {
  createManualAdjustment,
  recalculateAttendanceDay,
  recalculateNewAttendanceEvent,
} from "./attendance/functions.js";
import { processAttendanceRecalculationJobs } from "./attendance/recalculation-jobs.js";
import { recalculateHolidayChange, recalculateLeaveChange } from "./attendance/source-change-triggers.js";
import { createBranch, deleteBranch } from "./branches/management.js";
import { createDepartment } from "./departments/management.js";
import {
  provisionDevice,
  rotateDeviceCredential,
  setDeviceEnabled,
} from "./devices/provisioning.js";
import { mapDeviceIdentity } from "./employees/mapping.js";
import { createEmployee, requestFingerprintEnrollment, updateEmployeeDepartment } from "./employees/management.js";
import { firestore } from "./firebase.js";
import { IngestError, errorBody } from "./ingest/errors.js";
import { FirestoreIngestRepository } from "./ingest/firestore-repository.js";
import { SecretManagerBridgeSecrets } from "./ingest/secret-manager.js";
import { IngestionService } from "./ingest/service.js";
import { MAX_BODY_BYTES, type HeaderSource } from "./ingest/types.js";
import { bootstrapOrganization } from "./onboarding/bootstrap.js";
import { assignEmployeeShift, saveShift } from "./shifts/management.js";
import { resolveShiftInference } from "./shifts/inference-management.js";
import {
  configureBillingProduct,
  createCustomerPortalSession,
  createSubscriptionCheckout,
  getSaasCatalog,
  setSubscriptionStatus,
} from "./billing/functions.js";
import { activateManualSubscription, listPlatformSubscriptions } from "./billing/platform.js";
import { getCurrentSubscription } from "./billing/access.js";
import { dodoPaymentsWebhook } from "./billing/webhook.js";
import { RealtimeSessionService } from "./realtime/session.js";

const ingestRepository = new FirestoreIngestRepository(firestore);
const bridgeSecrets = new SecretManagerBridgeSecrets();
const ingestion = new IngestionService(ingestRepository, bridgeSecrets);
const realtimeSessions = new RealtimeSessionService(ingestRepository, bridgeSecrets);

function bridgeVersion(headers: HeaderSource): string | undefined {
  const value = headers["x-hikbridge-agent-version"];
  return typeof value === "string" && /^[0-9A-Za-z.+_-]{1,64}$/.test(value) ? value : undefined;
}

export const hikbridgeV1Events = onRequest({
  region: "asia-south1",
  timeoutSeconds: 60,
  memory: "256MiB",
  maxInstances: 100,
  concurrency: 20,
  invoker: "public",
}, async (request, response) => {
  response.set("Cache-Control", "no-store");
  response.set("Content-Type", "application/json; charset=utf-8");
  if (request.method !== "POST") {
    response.set("Allow", "POST");
    response.status(405).json(errorBody(new IngestError(405, "method_not_allowed", "Use POST for HikBridge ingestion")));
    return;
  }
  if (!request.is("application/json")) {
    response.status(415).json(errorBody(new IngestError(415, "invalid_content_type", "Content-Type must be application/json")));
    return;
  }
  const rawBody = request.rawBody;
  if (!Buffer.isBuffer(rawBody) || rawBody.length > MAX_BODY_BYTES) {
    response.status(413).json(errorBody(new IngestError(413, "body_too_large", "Request body exceeds the size limit")));
    return;
  }
  const headers = request.headers as HeaderSource;
  try {
    const agentVersion = bridgeVersion(headers);
    const result = await ingestion.ingest({
      headers,
      rawBody,
      now: new Date(),
      ...(agentVersion === undefined ? {} : { bridgeVersion: agentVersion }),
    });
    logger.info("hikbridge_ingest_success", {
      deviceId: result.deviceId,
      organizationId: result.organizationId,
      accepted: result.accepted.length,
      duplicates: result.duplicates.length,
      rejected: result.rejected.length,
    });
    response.status(200).json(result);
  } catch (error) {
    if (error instanceof IngestError) {
      logger.warn("hikbridge_ingest_rejected", {
        code: error.code,
        status: error.status,
        deviceId: typeof headers["x-hikbridge-device"] === "string" ? headers["x-hikbridge-device"] : "invalid",
      });
      response.status(error.status).json(errorBody(error));
      return;
    }
    logger.error("hikbridge_ingest_failed", { error });
    response.status(500).json(errorBody(new IngestError(500, "internal", "Attendance ingestion failed")));
  }
});

export const hikbridgeV1Session = onRequest({
  region: "asia-south1",
  timeoutSeconds: 30,
  memory: "256MiB",
  maxInstances: 20,
  concurrency: 40,
  invoker: "public",
}, async (request, response) => {
  response.set("Cache-Control", "no-store");
  response.set("Content-Type", "application/json; charset=utf-8");
  if (request.method !== "POST") {
    response.set("Allow", "POST");
    response.status(405).json(errorBody(new IngestError(405, "method_not_allowed", "Use POST for HikBridge realtime sessions")));
    return;
  }
  if (!request.is("application/json") || !Buffer.isBuffer(request.rawBody)) {
    response.status(415).json(errorBody(new IngestError(415, "invalid_content_type", "Content-Type must be application/json")));
    return;
  }
  const headers = request.headers as HeaderSource;
  try {
    const result = await realtimeSessions.create({ headers, rawBody: request.rawBody, now: new Date() });
    logger.info("hikbridge_realtime_session_created", { deviceId: result.deviceId, organizationId: result.organizationId });
    response.status(200).json(result);
  } catch (error) {
    if (error instanceof SyntaxError) {
      response.status(400).json(errorBody(new IngestError(400, "invalid_request", "Realtime session request is malformed")));
      return;
    }
    if (error instanceof IngestError) {
      response.status(error.status).json(errorBody(error));
      return;
    }
    logger.error("hikbridge_realtime_session_failed", { error });
    response.status(500).json(errorBody(new IngestError(500, "internal", "Realtime session creation failed")));
  }
});

export {
  activateManualSubscription,
  assignEmployeeShift,
  bootstrapOrganization,
  configureBillingProduct,
  createBranch,
  createCustomerPortalSession,
  createDepartment,
  createEmployee,
  createManualAdjustment,
  createSubscriptionCheckout,
  deleteBranch,
  dodoPaymentsWebhook,
  getSaasCatalog,
  getCurrentSubscription,
  listPlatformSubscriptions,
  mapDeviceIdentity,
  processAttendanceRecalculationJobs,
  provisionDevice,
  requestFingerprintEnrollment,
  recalculateAttendanceDay,
  recalculateHolidayChange,
  recalculateLeaveChange,
  recalculateNewAttendanceEvent,
  rotateDeviceCredential,
  resolveShiftInference,
  saveShift,
  setDeviceEnabled,
  setSubscriptionStatus,
  updateEmployeeDepartment,
};
