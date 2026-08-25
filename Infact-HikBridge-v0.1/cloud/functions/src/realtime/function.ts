import { logger } from "firebase-functions";
import { onRequest } from "firebase-functions/v2/https";

import { firestore } from "../firebase.js";
import { IngestError, errorBody } from "../ingest/errors.js";
import { FirestoreIngestRepository } from "../ingest/firestore-repository.js";
import { SecretManagerBridgeSecrets } from "../ingest/secret-manager.js";
import type { HeaderSource } from "../ingest/types.js";
import { RealtimeSessionService } from "./session.js";

const realtimeSessions = new RealtimeSessionService(
  new FirestoreIngestRepository(firestore),
  new SecretManagerBridgeSecrets(),
);

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
    response.status(405).json(errorBody(
      new IngestError(405, "method_not_allowed", "Use POST for HikBridge realtime sessions"),
    ));
    return;
  }
  if (!request.is("application/json") || !Buffer.isBuffer(request.rawBody)) {
    response.status(415).json(errorBody(
      new IngestError(415, "invalid_content_type", "Content-Type must be application/json"),
    ));
    return;
  }
  const headers = request.headers as HeaderSource;
  try {
    const result = await realtimeSessions.create({ headers, rawBody: request.rawBody, now: new Date() });
    logger.info("hikbridge_realtime_session_created", {
      deviceId: result.deviceId,
      organizationId: result.organizationId,
    });
    response.status(200).json(result);
  } catch (error) {
    if (error instanceof IngestError) {
      response.status(error.status).json(errorBody(error));
      return;
    }
    logger.error("hikbridge_realtime_session_failed", { error });
    response.status(500).json(errorBody(
      new IngestError(500, "internal", "Realtime session creation failed"),
    ));
  }
});
