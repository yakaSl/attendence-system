import { describe, expect, it } from "vitest";

import { computeSignature, sha256Hex } from "../src/ingest/protocol.js";
import { IngestionService, type IngestInput } from "../src/ingest/service.js";
import {
  PROTOCOL_VERSION,
  type BridgeStatus,
  type BridgeSecretProvider,
  type DeviceRegistration,
  type EventWriteContext,
  type EventWriteResult,
  type IngestRepository,
  type NormalizedEvent,
  type ReplayClaim,
} from "../src/ingest/types.js";

const now = new Date("2026-08-23T12:00:00.000Z");
const secret = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const registration: DeviceRegistration = {
  deviceId: "office-main-01",
  organizationId: "org-1",
  branchId: "branch-1",
  deviceDocumentPath: "organizations/org-1/devices/office-main-01",
  enabled: true,
  secretVersionNames: ["test-secret"],
};

class MemoryRepository implements IngestRepository {
  readonly stored = new Set<string>();
  readonly replays = new Map<string, string>();
  readonly contacts: Array<{ connected: boolean | undefined; version: string | undefined }> = [];

  async getDevice(deviceId: string): Promise<DeviceRegistration | null> {
    return deviceId === registration.deviceId ? registration : null;
  }

  async claimReplay(
    _registration: DeviceRegistration,
    nonce: string,
    bodyHash: string,
    _receivedAt: Date,
  ): Promise<ReplayClaim> {
    const existing = this.replays.get(nonce);
    if (existing !== undefined) return existing === bodyHash ? "repeat" : "conflict";
    this.replays.set(nonce, bodyHash);
    return "new";
  }

  async writeEvents(
    _registration: DeviceRegistration,
    events: NormalizedEvent[],
    _context: EventWriteContext,
  ): Promise<EventWriteResult> {
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const event of events) {
      if (this.stored.has(event.id)) duplicates.push(event.id);
      else {
        this.stored.add(event.id);
        accepted.push(event.id);
      }
    }
    return { accepted, duplicates };
  }

  async recordContact(
    _registration: DeviceRegistration,
    status: BridgeStatus | undefined,
    context: EventWriteContext,
  ): Promise<void> {
    this.contacts.push({ connected: status?.deviceConnected, version: context.bridgeVersion });
  }
}

class StaticSecrets implements BridgeSecretProvider {
  async getSecrets(): Promise<Buffer[]> {
    return [secret];
  }
}

function event(id = "a".repeat(64), deviceId = registration.deviceId): Record<string, unknown> {
  return {
    id,
    deviceId,
    serialNo: 4101,
    employeeNo: "17",
    name: "Kasun Perera",
    eventTime: "2026-08-23T08:47:13+05:30",
    major: 5,
    minor: 75,
    attendanceStatus: "checkIn",
    currentVerifyMode: "fingerPrint",
    raw: { futureFirmwareField: true },
    receivedAt: "2026-08-23T03:17:14Z",
  };
}

function signedInput(
  events: unknown[],
  nonce: string,
  options: { probe?: boolean; timestamp?: string; deviceId?: string; status?: Record<string, unknown>; bridgeVersion?: string } = {},
): IngestInput {
  const deviceId = options.deviceId ?? registration.deviceId;
  const timestamp = options.timestamp ?? Math.floor(now.getTime() / 1000).toString();
  const rawBody = Buffer.from(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    requestId: nonce,
    deviceId,
    ...(options.probe === true ? { probe: true } : {}),
    ...(options.status === undefined ? {} : { status: options.status }),
    events,
  }), "utf8");
  return {
    headers: {
      "x-hikbridge-version": PROTOCOL_VERSION,
      "x-hikbridge-device": deviceId,
      "x-hikbridge-timestamp": timestamp,
      "x-hikbridge-nonce": nonce,
      "x-hikbridge-signature": computeSignature(secret, deviceId, timestamp, nonce, rawBody),
    },
    rawBody,
    now,
    ...(options.bridgeVersion === undefined ? {} : { bridgeVersion: options.bridgeVersion }),
  };
}

function service(repository = new MemoryRepository()): { service: IngestionService; repository: MemoryRepository } {
  return { service: new IngestionService(repository, new StaticSecrets()), repository };
}

describe("IngestionService", () => {
  it("accepts a valid signed event", async () => {
    const subject = service();
    const result = await subject.service.ingest(signedInput([event()], "1".repeat(32)));
    expect(result.accepted).toEqual(["a".repeat(64)]);
    expect(result.duplicates).toEqual([]);
    expect(subject.repository.stored).toContain("a".repeat(64));
  });

  it("rejects an invalid signature", async () => {
    const subject = service();
    const input = signedInput([event()], "2".repeat(32));
    input.headers["x-hikbridge-signature"] = "0".repeat(64);
    await expect(subject.service.ingest(input)).rejects.toMatchObject({
      status: 401,
      code: "invalid_signature",
    });
  });

  it("rejects an expired request even when correctly signed", async () => {
    const subject = service();
    const timestamp = Math.floor((now.getTime() - 10 * 60 * 1000) / 1000).toString();
    const input = signedInput([event()], "3".repeat(32), { timestamp });
    await expect(subject.service.ingest(input)).rejects.toMatchObject({
      status: 401,
      code: "stale_request",
    });
  });

  it("returns a deterministic duplicate on an ambiguous retry", async () => {
    const subject = service();
    const first = await subject.service.ingest(signedInput([event()], "4".repeat(32)));
    const retry = await subject.service.ingest(signedInput([event()], "5".repeat(32)));
    expect(first.accepted).toHaveLength(1);
    expect(retry.accepted).toEqual([]);
    expect(retry.duplicates).toEqual(["a".repeat(64)]);
  });

  it("classifies a cross-device event as permanently rejected", async () => {
    const subject = service();
    const result = await subject.service.ingest(signedInput([event("b".repeat(64), "other-device")], "6".repeat(32)));
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([expect.objectContaining({ id: "b".repeat(64), code: "cross_device_event" })]);
  });

  it("classifies malformed event fields without losing its valid ID", async () => {
    const subject = service();
    const malformed = { ...event("c".repeat(64)), eventTime: "not-a-time" };
    const result = await subject.service.ingest(signedInput([malformed], "7".repeat(32)));
    expect(result.rejected).toEqual([expect.objectContaining({ id: "c".repeat(64), code: "invalid_event" })]);
  });

  it("rejects oversized batches before writing", async () => {
    const subject = service();
    const events = Array.from({ length: 101 }, (_, index) => event(index.toString(16).padStart(64, "0")));
    await expect(subject.service.ingest(signedInput(events, "8".repeat(32)))).rejects.toMatchObject({
      status: 413,
      code: "batch_too_large",
    });
    expect(subject.repository.stored.size).toBe(0);
  });

  it("rejects a nonce reused for different signed content", async () => {
    const subject = service();
    const nonce = "9".repeat(32);
    const first = signedInput([event("d".repeat(64))], nonce);
    const second = signedInput([event("e".repeat(64))], nonce);
    expect(sha256Hex(first.rawBody)).not.toBe(sha256Hex(second.rawBody));
    await subject.service.ingest(first);
    await expect(subject.service.ingest(second)).rejects.toMatchObject({
      status: 409,
      code: "replay_conflict",
    });
  });

  it("authenticates a probe without creating attendance events", async () => {
    const subject = service();
    const result = await subject.service.ingest(signedInput([], "f".repeat(32), { probe: true }));
    expect(result.organizationId).toBe("org-1");
    expect(result.accepted).toEqual([]);
    expect(subject.repository.stored.size).toBe(0);
  });

  it("records a signed offline health report without creating events", async () => {
    const subject = service();
    await subject.service.ingest(signedInput([], "0".repeat(32), {
      probe: true,
      bridgeVersion: "0.1.0",
      status: {
        deviceConnected: false,
        lastSuccessfulDevicePoll: "2026-08-23T11:58:00Z",
        pendingEvents: 7,
        deviceModel: "DS-K1A8503EF",
        firmwareVersion: "V3.3.0",
      },
    }));
    expect(subject.repository.contacts).toEqual([{ connected: false, version: "0.1.0" }]);
    expect(subject.repository.stored.size).toBe(0);
  });
});
