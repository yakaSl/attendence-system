import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";

import { FirestoreIngestRepository, identityKey } from "../src/ingest/firestore-repository.js";
import type { DeviceRegistration, NormalizedEvent } from "../src/ingest/types.js";

const app = getApps()[0] ?? initializeApp({ projectId: "demo-hikbridge" });
const db = getFirestore(app);
const organizationId = "org-repository-test";
const registration: DeviceRegistration = {
  deviceId: "device-repository-test",
  organizationId,
  branchId: "branch-1",
  deviceDocumentPath: `organizations/${organizationId}/devices/device-repository-test`,
  enabled: true,
  secretVersionNames: ["unused"],
};

function event(idCharacter: string, serialNo: number): NormalizedEvent {
  return {
    id: idCharacter.repeat(64),
    deviceId: registration.deviceId,
    serialNo,
    employeeNo: "17",
    name: "Kasun",
    eventTime: `2026-08-23T08:47:${serialNo.toString().padStart(2, "0")}+05:30`,
    major: 5,
    minor: 75,
    currentVerifyMode: "fingerPrint",
    raw: { fixture: true },
    receivedAt: "2026-08-23T03:17:14Z",
  };
}

beforeEach(async () => {
  await db.recursiveDelete(db.collection("organizations").doc(organizationId));
  await db.recursiveDelete(db.collection("_bridgeReplay"));
  await db.doc(registration.deviceDocumentPath).set({ name: "Main Entrance" });
});

describe("FirestoreIngestRepository with emulator", () => {
  it("creates deterministic event documents once and does not inflate unmapped counts on retry", async () => {
    const repository = new FirestoreIngestRepository(db);
    const events = [event("a", 1), event("b", 2)];
    const context = {
      requestId: "1".repeat(32),
      receivedAt: new Date("2026-08-23T03:17:20Z"),
      bridgeVersion: "0.1.0",
    };
    const first = await repository.writeEvents(registration, events, context);
    const retry = await repository.writeEvents(registration, events, { ...context, requestId: "2".repeat(32) });
    expect(first.accepted).toEqual(events.map((value) => value.id));
    expect(retry.duplicates).toEqual(events.map((value) => value.id));
    const rawEvents = await db.collection(`organizations/${organizationId}/attendanceEvents`).get();
    expect(rawEvents.size).toBe(2);
    const unmapped = await db.doc(`organizations/${organizationId}/unmappedIdentities/${identityKey(registration.deviceId, "17")}`).get();
    expect(unmapped.get("eventCount")).toBe(2);
    expect((await db.doc(registration.deviceDocumentPath).get()).get("bridgeVersion")).toBe("0.1.0");
  });

  it("claims identical replays and rejects conflicting nonce content", async () => {
    const repository = new FirestoreIngestRepository(db);
    const receivedAt = Timestamp.fromDate(new Date("2026-08-23T03:17:20Z")).toDate();
    expect(await repository.claimReplay(registration, "a".repeat(32), "body-1", receivedAt)).toBe("new");
    expect(await repository.claimReplay(registration, "a".repeat(32), "body-1", receivedAt)).toBe("repeat");
    expect(await repository.claimReplay(registration, "a".repeat(32), "body-2", receivedAt)).toBe("conflict");
  });

  it("records bridge health without creating a raw attendance event", async () => {
    const repository = new FirestoreIngestRepository(db);
    await repository.recordContact(registration, {
      deviceConnected: false,
      lastSuccessfulDevicePoll: "2026-08-23T03:15:00Z",
      pendingEvents: 4,
      deviceModel: "DS-K1A8503EF",
      deviceSerial: "TEST-SERIAL",
      firmwareVersion: "V3.3.0",
    }, {
      requestId: "3".repeat(32),
      receivedAt: new Date("2026-08-23T03:17:20Z"),
      bridgeVersion: "0.1.0",
    });
    const device = await db.doc(registration.deviceDocumentPath).get();
    expect(device.get("connectionStatus")).toBe("offline");
    expect(device.get("pendingLocalEvents")).toBe(4);
    expect(device.get("deviceModel")).toBe("DS-K1A8503EF");
    expect(device.get("bridgeVersion")).toBe("0.1.0");
    expect((await db.collection(`organizations/${organizationId}/attendanceEvents`).get()).size).toBe(0);
  });
});
