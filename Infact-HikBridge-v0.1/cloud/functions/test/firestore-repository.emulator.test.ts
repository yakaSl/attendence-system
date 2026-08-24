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

  it("does not overwrite terminal connectivity during a command-only probe", async () => {
    await db.doc(registration.deviceDocumentPath).set({ connectionStatus: "offline" }, { merge: true });
    const repository = new FirestoreIngestRepository(db);
    await repository.recordContact(registration, undefined, {
      requestId: "6".repeat(32),
      receivedAt: new Date("2026-08-23T03:17:20Z"),
    });
    expect((await db.doc(registration.deviceDocumentPath).get()).get("connectionStatus")).toBe("offline");
  });

  it("leases one fingerprint command and records only non-biometric completion metadata", async () => {
    const repository = new FirestoreIngestRepository(db);
    const commands = db.collection(`organizations/${organizationId}/devices/${registration.deviceId}/commands`);
    const issuedAt = Timestamp.fromDate(new Date("2026-08-23T12:00:00Z"));
    const expiresAt = Timestamp.fromDate(new Date("2026-08-23T12:05:00Z"));
    await commands.doc("command-1").set({
      organizationId,
      branchId: registration.branchId,
      deviceId: registration.deviceId,
      type: "enroll_fingerprint",
      state: "queued",
      employeeId: "employee-1",
      employeeNo: "17",
      name: "Employee 1",
      fingerPrintId: 1,
      attempts: 0,
      createdAt: issuedAt,
      expiresAt,
      updatedAt: issuedAt,
    });
    await db.doc(
      `organizations/${organizationId}/devices/${registration.deviceId}/commandLocks/fingerprint`,
    ).set({ commandId: "command-1", expiresAt });

    const context = { requestId: "4".repeat(32), receivedAt: new Date("2026-08-23T12:01:00Z") };
    const delivery = await repository.exchangeCommands(registration, [], context, true);
    expect(delivery.commands).toHaveLength(1);
    expect(delivery.commands[0]?.payload).toMatchObject({ employeeNo: "17", fingerPrintId: 1 });
    expect(JSON.stringify(delivery)).not.toContain("fingerData");

    const completed = await repository.exchangeCommands(registration, [{
      commandId: "command-1",
      state: "succeeded",
      output: { employeeNo: "17", fingerPrintId: 1, quality: 88 },
    }], { ...context, requestId: "5".repeat(32) }, false);
    expect(completed.acknowledgedCommandIds).toEqual(["command-1"]);
    expect((await commands.doc("command-1").get()).data()).toMatchObject({ state: "succeeded" });
    expect((await db.doc(
      `organizations/${organizationId}/deviceEnrollments/${identityKey(registration.deviceId, "17")}`,
    ).get()).data()).toMatchObject({ state: "enrolled", fingerPrintId: 1, quality: 88 });
    expect((await db.doc(
      `organizations/${organizationId}/devices/${registration.deviceId}/commandLocks/fingerprint`,
    ).get()).exists).toBe(false);
  });

  it("does not regress an active fingerprint state when an earlier user sync finishes", async () => {
    const repository = new FirestoreIngestRepository(db);
    const now = Timestamp.fromDate(new Date("2026-08-23T12:01:00Z"));
    const command = db.doc(
      `organizations/${organizationId}/devices/${registration.deviceId}/commands/user-command`,
    );
    const enrollment = db.doc(
      `organizations/${organizationId}/deviceEnrollments/${identityKey(registration.deviceId, "17")}`,
    );
    await command.set({
      deviceId: registration.deviceId,
      type: "upsert_user",
      state: "dispatched",
      employeeId: "employee-1",
      employeeNo: "17",
      name: "Employee 1",
      createdAt: now,
      expiresAt: Timestamp.fromDate(new Date("2026-08-23T12:05:00Z")),
    });
    await enrollment.set({
      deviceId: registration.deviceId,
      employeeId: "employee-1",
      employeeNo: "17",
      state: "queued",
      commandId: "fingerprint-command",
    });

    await repository.exchangeCommands(registration, [{
      commandId: "user-command",
      state: "succeeded",
      output: { employeeNo: "17" },
    }], { requestId: "7".repeat(32), receivedAt: now.toDate() }, false);
    expect((await enrollment.get()).data()).toMatchObject({
      state: "queued",
      commandId: "fingerprint-command",
      lastUserSyncError: null,
    });
  });
});
