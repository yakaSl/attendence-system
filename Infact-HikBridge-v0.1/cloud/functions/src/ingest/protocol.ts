import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import { IngestError } from "./errors.js";
import {
  PROTOCOL_VERSION,
  REQUEST_SKEW_SECONDS,
  type BridgeHeaders,
  type HeaderSource,
  type HeaderValue,
} from "./types.js";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^[0-9]{10,11}$/;

function oneHeader(headers: HeaderSource, name: string): string {
  const value: HeaderValue = headers[name.toLowerCase()];
  if (typeof value !== "string" || value.length === 0) {
    throw new IngestError(400, "invalid_headers", `Missing or repeated ${name} header`);
  }
  return value;
}

export function parseBridgeHeaders(
  headers: HeaderSource,
  now: Date,
): BridgeHeaders {
  const version = oneHeader(headers, "X-HikBridge-Version");
  const deviceId = oneHeader(headers, "X-HikBridge-Device");
  const timestamp = oneHeader(headers, "X-HikBridge-Timestamp");
  const nonce = oneHeader(headers, "X-HikBridge-Nonce");
  const signature = oneHeader(headers, "X-HikBridge-Signature");
  if (version !== PROTOCOL_VERSION) {
    throw new IngestError(400, "unsupported_version", "Unsupported HikBridge protocol version");
  }
  if (!DEVICE_ID_PATTERN.test(deviceId) || !TIMESTAMP_PATTERN.test(timestamp) ||
      !NONCE_PATTERN.test(nonce) || !SIGNATURE_PATTERN.test(signature)) {
    throw new IngestError(400, "invalid_headers", "One or more HikBridge headers are malformed");
  }
  const timestampSeconds = Number(timestamp);
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - timestampSeconds);
  if (!Number.isSafeInteger(timestampSeconds) || skew > REQUEST_SKEW_SECONDS) {
    throw new IngestError(401, "stale_request", "Request timestamp is outside the accepted window");
  }
  return { version, deviceId, timestamp, timestampSeconds, nonce, signature };
}

export function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export function computeSignature(
  secret: Buffer,
  deviceId: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
): string {
  const canonical = [
    "hikbridge-hmac-sha256",
    PROTOCOL_VERSION,
    deviceId,
    timestamp,
    nonce,
    sha256Hex(body),
  ].join("\n");
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

export function hasValidSignature(
  secrets: Buffer[],
  headers: BridgeHeaders,
  body: Buffer,
): boolean {
  const provided = Buffer.from(headers.signature, "hex");
  let valid = false;
  for (const secret of secrets) {
    const expected = Buffer.from(
      computeSignature(secret, headers.deviceId, headers.timestamp, headers.nonce, body),
      "hex",
    );
    // Do not return early. Rotation keys receive the same comparison work.
    valid = timingSafeEqual(provided, expected) || valid;
  }
  return valid;
}
