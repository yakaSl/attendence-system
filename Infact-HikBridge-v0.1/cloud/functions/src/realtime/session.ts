import { getAuth } from "firebase-admin/auth";
import { z } from "zod";

import { firebaseApp } from "../firebase.js";
import { IngestError } from "../ingest/errors.js";
import { hasValidSignature, parseBridgeHeaders, sha256Hex } from "../ingest/protocol.js";
import {
  PROTOCOL_VERSION,
  type BridgeSecretProvider,
  type HeaderSource,
  type IngestRepository,
} from "../ingest/types.js";

const sessionEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().regex(/^[a-f0-9]{32}$/),
  deviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
}).strict();

export interface RealtimeSessionInput {
  headers: HeaderSource;
  rawBody: Buffer;
  now: Date;
}

export interface RealtimeSessionResponse {
  protocolVersion: string;
  requestId: string;
  deviceId: string;
  organizationId: string;
  databaseUrl: string;
  firebaseApiKey: string;
  customToken: string;
  controlPath: string;
}

export interface CustomTokenIssuer {
  createCustomToken(uid: string, developerClaims?: object): Promise<string>;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is not configured`);
  return value.replace(/\/$/, "");
}

export class RealtimeSessionService {
  constructor(
    private readonly repository: IngestRepository,
    private readonly secrets: BridgeSecretProvider,
    private readonly auth: CustomTokenIssuer = getAuth(firebaseApp),
  ) {}

  async create(input: RealtimeSessionInput): Promise<RealtimeSessionResponse> {
    if (input.rawBody.length > 4096) {
      throw new IngestError(413, "body_too_large", "Realtime session request exceeds the size limit");
    }
    const headers = parseBridgeHeaders(input.headers, input.now);
    let body: unknown;
    try {
      body = JSON.parse(input.rawBody.toString("utf8"));
    } catch {
      throw new IngestError(400, "invalid_request", "Realtime session request is malformed");
    }
    const parsedBody = sessionEnvelopeSchema.safeParse(body);
    if (!parsedBody.success) {
      throw new IngestError(400, "invalid_request", "Realtime session request is malformed");
    }
    const envelope = parsedBody.data;
    if (envelope.deviceId !== headers.deviceId || envelope.requestId !== headers.nonce) {
      throw new IngestError(400, "invalid_request", "Signed headers and request body do not match");
    }
    const registration = await this.repository.getDevice(headers.deviceId);
    if (registration === null) throw new IngestError(401, "device_not_found", "Bridge authentication failed");
    if (!registration.enabled) throw new IngestError(403, "device_disabled", "Bridge device is disabled");
    const secrets = await this.secrets.getSecrets(registration);
    if (secrets.length === 0 || !hasValidSignature(secrets, headers, input.rawBody)) {
      throw new IngestError(401, "invalid_signature", "Bridge authentication failed");
    }
    const replay = await this.repository.claimReplay(
      registration,
      headers.nonce,
      sha256Hex(input.rawBody),
      input.now,
    );
    if (replay === "conflict") throw new IngestError(409, "replay_conflict", "Request nonce was reused with different content");

    const customToken = await this.auth.createCustomToken(`bridge-${registration.deviceId}`, {
      bridgeDeviceId: registration.deviceId,
      organizationId: registration.organizationId,
      bridge: true,
    });
    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId: envelope.requestId,
      deviceId: registration.deviceId,
      organizationId: registration.organizationId,
      databaseUrl: requiredEnvironment("BRIDGE_REALTIME_DATABASE_URL"),
      firebaseApiKey: requiredEnvironment("BRIDGE_FIREBASE_WEB_API_KEY"),
      customToken,
      controlPath: `bridgeRealtime/v1/control/${registration.organizationId}/${registration.deviceId}`,
    };
  }
}
