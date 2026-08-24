import { IngestError } from "./errors.js";
import { hasValidSignature, parseBridgeHeaders, sha256Hex } from "./protocol.js";
import { classifyEvents, parseEnvelope } from "./schema.js";
import {
  MAX_BODY_BYTES,
  PROTOCOL_VERSION,
  type BridgeSecretProvider,
  type HeaderSource,
  type IngestRepository,
  type IngestResponse,
} from "./types.js";

export interface IngestInput {
  headers: HeaderSource;
  rawBody: Buffer;
  now: Date;
  bridgeVersion?: string;
}

export class IngestionService {
  constructor(
    private readonly repository: IngestRepository,
    private readonly secrets: BridgeSecretProvider,
  ) {}

  async ingest(input: IngestInput): Promise<IngestResponse> {
    if (input.rawBody.length > MAX_BODY_BYTES) {
      throw new IngestError(413, "body_too_large", "Request body exceeds the size limit");
    }
    const headers = parseBridgeHeaders(input.headers, input.now);
    const registration = await this.repository.getDevice(headers.deviceId);
    if (registration === null) {
      throw new IngestError(401, "device_not_found", "Bridge authentication failed");
    }
    if (!registration.enabled) {
      throw new IngestError(403, "device_disabled", "Bridge device is disabled");
    }
    const secrets = await this.secrets.getSecrets(registration);
    if (secrets.length === 0 || !hasValidSignature(secrets, headers, input.rawBody)) {
      throw new IngestError(401, "invalid_signature", "Bridge authentication failed");
    }
    const envelope = parseEnvelope(input.rawBody);
    if (envelope.deviceId !== headers.deviceId || envelope.requestId !== headers.nonce) {
      throw new IngestError(400, "invalid_request", "Signed headers and request body do not match");
    }
    if (envelope.probe && envelope.events.length !== 0) {
      throw new IngestError(400, "invalid_request", "A probe request cannot contain events");
    }
    if (!envelope.probe && envelope.status !== undefined) {
      throw new IngestError(400, "invalid_request", "Bridge status is accepted only on probe requests");
    }
    if (!envelope.probe && envelope.events.length === 0) {
      throw new IngestError(400, "invalid_request", "An event request cannot be empty");
    }
    const classified = classifyEvents(envelope.events, headers.deviceId, input.now);
    const replay = await this.repository.claimReplay(
      registration,
      headers.nonce,
      sha256Hex(input.rawBody),
      input.now,
    );
    if (replay === "conflict") {
      throw new IngestError(409, "replay_conflict", "Request nonce was reused with different content");
    }
    if (envelope.probe) {
      await this.repository.recordContact(registration, envelope.status, {
        requestId: envelope.requestId,
        receivedAt: input.now,
        ...(input.bridgeVersion === undefined ? {} : { bridgeVersion: input.bridgeVersion }),
      });
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId: envelope.requestId,
        deviceId: envelope.deviceId,
        organizationId: registration.organizationId,
        branchId: registration.branchId,
        accepted: [],
        duplicates: [],
        rejected: [],
      };
    }
    const writeResult = await this.repository.writeEvents(
      registration,
      classified.valid,
      {
        requestId: envelope.requestId,
        receivedAt: input.now,
        ...(input.bridgeVersion === undefined ? {} : { bridgeVersion: input.bridgeVersion }),
      },
    );
    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId: envelope.requestId,
      deviceId: envelope.deviceId,
      organizationId: registration.organizationId,
      branchId: registration.branchId,
      accepted: writeResult.accepted,
      duplicates: writeResult.duplicates,
      rejected: classified.rejected,
    };
  }
}
