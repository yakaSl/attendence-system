import { logger } from "firebase-functions";
import { onRequest } from "firebase-functions/v2/https";

import {
  createManualAdjustment,
  recalculateAttendanceDay,
  recalculateNewAttendanceEvent,
} from "./attendance/functions.js";
import { processAttendanceRecalculationJobs } from "./attendance/recalculation-jobs.js";
import { recalculateHolidayChange, recalculateLeaveChange } from "./attendance/source-change-triggers.js";
import {
  provisionDevice,
  rotateDeviceCredential,
  setDeviceEnabled,
} from "./devices/provisioning.js";
import { mapDeviceIdentity } from "./employees/mapping.js";
import { firestore } from "./firebase.js";
import { IngestError, errorBody } from "./ingest/errors.js";
import { FirestoreIngestRepository } from "./ingest/firestore-repository.js";
import { SecretManagerBridgeSecrets } from "./ingest/secret-manager.js";
import { IngestionService } from "./ingest/service.js";
import { MAX_BODY_BYTES, type HeaderSource } from "./ingest/types.js";
import { bootstrapOrganization } from "./onboarding/bootstrap.js";
import { assignEmployeeShift, saveShift } from "./shifts/management.js";

const ingestion = new IngestionService(
  new FirestoreIngestRepository(firestore),
  new SecretManagerBridgeSecrets(),
);

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

export {
  assignEmployeeShift,
  bootstrapOrganization,
  createManualAdjustment,
  mapDeviceIdentity,
  processAttendanceRecalculationJobs,
  provisionDevice,
  recalculateAttendanceDay,
  recalculateHolidayChange,
  recalculateLeaveChange,
  recalculateNewAttendanceEvent,
  rotateDeviceCredential,
  saveShift,
  setDeviceEnabled,
};
