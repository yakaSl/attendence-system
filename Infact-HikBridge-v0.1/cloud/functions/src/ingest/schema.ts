import { z } from "zod";

import { IngestError } from "./errors.js";
import {
  MAX_BATCH_SIZE,
  MAX_RAW_EVENT_BYTES,
  PROTOCOL_VERSION,
  type IngestEnvelope,
  type NormalizedEvent,
  type RejectedEvent,
} from "./types.js";

const eventId = z.string().regex(/^[a-f0-9]{64}$/);
const deviceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const optionalText = (max: number) => z.string().max(max).optional();
const commandId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

const bridgeStatusSchema = z.object({
  deviceConnected: z.boolean(),
  lastSuccessfulDevicePoll: z.iso.datetime({ offset: true }).optional(),
  pendingEvents: z.number().int().nonnegative().max(1_000_000),
  deviceModel: optionalText(128),
  deviceSerial: optionalText(128),
  firmwareVersion: optionalText(128),
}).strict();

const eventSchema = z.object({
  id: eventId,
  deviceId,
  deviceSerial: optionalText(128),
  serialNo: z.number().int().nonnegative().safe().optional(),
  employeeNo: optionalText(128),
  name: optionalText(256),
  eventTime: z.iso.datetime({ offset: true }),
  major: z.number().int().min(0).max(65535),
  minor: z.number().int().min(0).max(65535),
  attendanceStatus: optionalText(128),
  currentVerifyMode: optionalText(128),
  cardNo: optionalText(128),
  cardReaderNo: z.number().int().nonnegative().max(65535).optional(),
  doorNo: z.number().int().nonnegative().max(65535).optional(),
  raw: z.unknown().optional(),
  receivedAt: z.iso.datetime({ offset: true }),
}).strict();

const commandResultSchema = z.object({
  commandId,
  state: z.enum(["succeeded", "failed"]),
  code: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
  message: z.string().trim().max(500).optional(),
  output: z.object({
    employeeNo: z.string().min(1).max(32).optional(),
    fingerPrintId: z.number().int().min(1).max(10).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  }).strict().optional(),
}).strict();

const commandResultsSchema = z.array(commandResultSchema).max(20).superRefine((results, context) => {
  const seen = new Set<string>();
  for (const [index, result] of results.entries()) {
    if (seen.has(result.commandId)) {
      context.addIssue({ code: "custom", message: "Command result IDs must be unique", path: [index, "commandId"] });
    }
    seen.add(result.commandId);
  }
});

const envelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().regex(/^[a-f0-9]{32}$/),
  deviceId,
  probe: z.boolean().optional().default(false),
  acceptCommands: z.boolean().optional().default(false),
  status: bridgeStatusSchema.optional(),
  commandResults: commandResultsSchema.optional().default([]),
  events: z.array(z.unknown()).max(MAX_BATCH_SIZE),
}).strict();

export function parseEnvelope(body: Buffer): IngestEnvelope {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body.toString("utf8"));
  } catch {
    throw new IngestError(400, "invalid_request", "Request body is not valid JSON");
  }
  const result = envelopeSchema.safeParse(decoded);
  if (!result.success) {
    const tooMany = typeof decoded === "object" && decoded !== null &&
      Array.isArray((decoded as { events?: unknown }).events) &&
      (decoded as { events: unknown[] }).events.length > MAX_BATCH_SIZE;
    throw new IngestError(
      tooMany ? 413 : 400,
      tooMany ? "batch_too_large" : "invalid_request",
      tooMany ? `Event batch exceeds ${MAX_BATCH_SIZE} records` : "Request envelope is malformed",
    );
  }
  return result.data;
}

export function classifyEvents(
  values: unknown[],
  expectedDeviceId: string,
  now: Date,
): { valid: NormalizedEvent[]; rejected: RejectedEvent[] } {
  const valid: NormalizedEvent[] = [];
  const rejected: RejectedEvent[] = [];
  const seen = new Set<string>();
  const earliest = new Date(now);
  earliest.setUTCFullYear(earliest.getUTCFullYear() - 5);
  const latest = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  for (const value of values) {
    const candidateId = typeof value === "object" && value !== null &&
      "id" in value && typeof value.id === "string" ? value.id : "";
    if (!/^[a-f0-9]{64}$/.test(candidateId)) {
      throw new IngestError(400, "invalid_request", "Every event must contain a valid deterministic ID");
    }
    if (seen.has(candidateId)) {
      throw new IngestError(400, "invalid_request", "An event ID is repeated within the batch");
    }
    seen.add(candidateId);
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) {
      rejected.push({ id: candidateId, code: "invalid_event", message: "Event fields are malformed" });
      continue;
    }
    if (parsed.data.deviceId !== expectedDeviceId) {
      rejected.push({ id: candidateId, code: "cross_device_event", message: "Event device does not match authenticated bridge" });
      continue;
    }
    const rawBytes = Buffer.byteLength(JSON.stringify(parsed.data.raw ?? null), "utf8");
    if (rawBytes > MAX_RAW_EVENT_BYTES) {
      rejected.push({ id: candidateId, code: "raw_payload_too_large", message: "Raw event exceeds the size limit" });
      continue;
    }
    const eventTime = new Date(parsed.data.eventTime);
    if (eventTime < earliest || eventTime > latest) {
      rejected.push({ id: candidateId, code: "event_time_out_of_range", message: "Event time is outside the accepted range" });
      continue;
    }
    valid.push(parsed.data);
  }
  return { valid, rejected };
}
