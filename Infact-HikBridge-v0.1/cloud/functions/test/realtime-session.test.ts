import { describe, expect, it } from "vitest";

import { computeSignature } from "../src/ingest/protocol.js";
import { RealtimeSessionService, type CustomTokenIssuer } from "../src/realtime/session.js";
import {
  PROTOCOL_VERSION,
  type BridgeSecretProvider,
  type DeviceRegistration,
  type IngestRepository,
} from "../src/ingest/types.js";

const now = new Date("2026-08-25T10:00:00.000Z");
const secret = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const registration: DeviceRegistration = {
  deviceId: "office-main-01",
  organizationId: "org-1",
  branchId: "branch-1",
  deviceDocumentPath: "organizations/org-1/devices/office-main-01",
  enabled: true,
  secretVersionNames: ["test-secret"],
};

function repository(): IngestRepository {
  return {
    async getDevice(deviceId) {
      return deviceId === registration.deviceId ? registration : null;
    },
    async claimReplay() {
      return "new";
    },
    async writeEvents() {
      throw new Error("not used by realtime sessions");
    },
    async recordContact() {
      throw new Error("not used by realtime sessions");
    },
    async exchangeCommands() {
      throw new Error("not used by realtime sessions");
    },
  };
}

class StaticSecrets implements BridgeSecretProvider {
  async getSecrets(): Promise<Buffer[]> {
    return [secret];
  }
}

class TokenIssuer implements CustomTokenIssuer {
  uid = "";
  claims: object = {};

  async createCustomToken(uid: string, claims?: object): Promise<string> {
    this.uid = uid;
    this.claims = claims ?? {};
    return "signed-custom-token";
  }
}

function signedInput(nonce: string) {
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const rawBody = Buffer.from(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    requestId: nonce,
    deviceId: registration.deviceId,
  }), "utf8");
  return {
    headers: {
      "x-hikbridge-version": PROTOCOL_VERSION,
      "x-hikbridge-device": registration.deviceId,
      "x-hikbridge-timestamp": timestamp,
      "x-hikbridge-nonce": nonce,
      "x-hikbridge-signature": computeSignature(secret, registration.deviceId, timestamp, nonce, rawBody),
    },
    rawBody,
    now,
  };
}

describe("RealtimeSessionService", () => {
  it("authenticates a bridge and scopes its Firebase token", async () => {
    process.env.BRIDGE_REALTIME_DATABASE_URL = "https://example.asia-southeast1.firebasedatabase.app";
    process.env.BRIDGE_FIREBASE_WEB_API_KEY = "firebase-web-api-key";
    const issuer = new TokenIssuer();
    const service = new RealtimeSessionService(repository(), new StaticSecrets(), issuer);

    const result = await service.create(signedInput("a".repeat(32)));

    expect(result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      deviceId: registration.deviceId,
      organizationId: registration.organizationId,
      customToken: "signed-custom-token",
      controlPath: "bridgeRealtime/v1/control/org-1/office-main-01",
    });
    expect(issuer.uid).toBe("bridge-office-main-01");
    expect(issuer.claims).toEqual({
      bridgeDeviceId: registration.deviceId,
      organizationId: registration.organizationId,
      bridge: true,
    });
  });

  it("rejects malformed JSON as a client error", async () => {
    const service = new RealtimeSessionService(repository(), new StaticSecrets(), new TokenIssuer());
    const input = signedInput("b".repeat(32));
    input.rawBody = Buffer.from("{");
    await expect(service.create(input)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });
});
