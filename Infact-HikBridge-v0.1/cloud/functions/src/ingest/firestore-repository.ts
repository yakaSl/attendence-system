import { createHash } from "node:crypto";

import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";

import type {
  BridgeStatus,
  DeviceRegistration,
  EventWriteContext,
  EventWriteResult,
  IngestRepository,
  NormalizedEvent,
  ReplayClaim,
} from "./types.js";

interface IdentityMapping {
  employeeId: string;
  active: boolean;
}

interface UnmappedAggregate {
  count: number;
  firstEventTime: Date;
  lastEventTime: Date;
  employeeNo: string;
}

function identityKey(deviceId: string, employeeNo: string): string {
  return createHash("sha256").update(`${deviceId}\0${employeeNo}`, "utf8").digest("hex");
}

function replayKey(deviceId: string, nonce: string): string {
  return createHash("sha256").update(`${deviceId}\0${nonce}`, "utf8").digest("hex");
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class FirestoreIngestRepository implements IngestRepository {
  constructor(private readonly db: Firestore) {}

  async getDevice(deviceId: string): Promise<DeviceRegistration | null> {
    const snapshot = await this.db.collection("bridgeDeviceRegistry").doc(deviceId).get();
    if (!snapshot.exists) {
      return null;
    }
    const data = snapshot.data() ?? {};
    const organizationId = requiredString(data.organizationId);
    const branchId = requiredString(data.branchId);
    const deviceDocumentPath = requiredString(data.deviceDocumentPath);
    const versions = Array.isArray(data.secretVersionNames) ?
      data.secretVersionNames.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
    if (organizationId === null || branchId === null || deviceDocumentPath === null || versions.length === 0) {
      throw new Error(`Bridge registry ${deviceId} is incomplete`);
    }
    const previousValidUntil = data.previousSecretValidUntil instanceof Timestamp ?
      data.previousSecretValidUntil.toDate() : null;
    const activeVersions = previousValidUntil !== null && previousValidUntil < new Date() ?
      versions.slice(0, 1) : versions.slice(0, 2);
    return {
      deviceId,
      organizationId,
      branchId,
      deviceDocumentPath,
      enabled: data.enabled === true && data.state === "active",
      secretVersionNames: activeVersions,
    };
  }

  async claimReplay(
    registration: DeviceRegistration,
    nonce: string,
    bodyHash: string,
    receivedAt: Date,
  ): Promise<ReplayClaim> {
    const ref = this.db.collection("_bridgeReplay").doc(replayKey(registration.deviceId, nonce));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) {
        return snapshot.get("bodyHash") === bodyHash ? "repeat" : "conflict";
      }
      transaction.create(ref, {
        deviceId: registration.deviceId,
        organizationId: registration.organizationId,
        bodyHash,
        receivedAt: Timestamp.fromDate(receivedAt),
        expiresAt: Timestamp.fromMillis(receivedAt.getTime() + 10 * 60 * 1000),
      });
      return "new";
    });
  }

  async writeEvents(
    registration: DeviceRegistration,
    events: NormalizedEvent[],
    context: EventWriteContext,
  ): Promise<EventWriteResult> {
    if (events.length === 0) {
      return { accepted: [], duplicates: [] };
    }
    const organization = this.db.collection("organizations").doc(registration.organizationId);
    const eventRefs = events.map((event) => organization.collection("attendanceEvents").doc(event.id));
    const uniqueIdentityKeys = [...new Set(
      events.filter((event) => event.employeeNo !== undefined && event.employeeNo !== "")
        .map((event) => identityKey(registration.deviceId, event.employeeNo ?? "")),
    )];
    const identityRefs = uniqueIdentityKeys.map((key) => organization.collection("deviceIdentities").doc(key));
    const unmappedRefs = uniqueIdentityKeys.map((key) => organization.collection("unmappedIdentities").doc(key));

    return this.db.runTransaction(async (transaction) => {
      const eventSnapshots = await transaction.getAll(...eventRefs);
      const identitySnapshots = identityRefs.length === 0 ? [] : await transaction.getAll(...identityRefs);
      const unmappedSnapshots = unmappedRefs.length === 0 ? [] : await transaction.getAll(...unmappedRefs);
      const mappings = this.mappingByKey(identitySnapshots);
      const existingUnmapped = new Map(unmappedSnapshots.map((snapshot) => [snapshot.id, snapshot]));
      const accepted: string[] = [];
      const duplicates: string[] = [];
      const aggregates = new Map<string, UnmappedAggregate>();

      for (const [index, event] of events.entries()) {
        const eventRef = eventRefs[index];
        const eventSnapshot = eventSnapshots[index];
        if (eventRef === undefined || eventSnapshot === undefined) {
          throw new Error("Firestore event transaction lost positional correspondence");
        }
        if (eventSnapshot.exists) {
          duplicates.push(event.id);
          continue;
        }
        const employeeNo = event.employeeNo ?? "";
        const key = employeeNo === "" ? "" : identityKey(registration.deviceId, employeeNo);
        const mapping = key === "" ? undefined : mappings.get(key);
        const mapped = mapping?.active === true;
        transaction.create(eventRef, this.eventDocument(registration, event, context, mapped ? mapping.employeeId : undefined));
        accepted.push(event.id);
        if (!mapped && employeeNo !== "") {
          const eventTime = new Date(event.eventTime);
          const aggregate = aggregates.get(key);
          if (aggregate === undefined) {
            aggregates.set(key, { count: 1, firstEventTime: eventTime, lastEventTime: eventTime, employeeNo });
          } else {
            aggregate.count++;
            if (eventTime < aggregate.firstEventTime) aggregate.firstEventTime = eventTime;
            if (eventTime > aggregate.lastEventTime) aggregate.lastEventTime = eventTime;
          }
        }
      }

      this.writeUnmappedAggregates(transaction, organization, registration, aggregates, existingUnmapped, context);
      const lastEventAt = events.reduce<Date | null>((latest, event) => {
        const current = new Date(event.eventTime);
        return latest === null || current > latest ? current : latest;
      }, null);
      transaction.set(this.db.doc(registration.deviceDocumentPath), {
        lastSeen: Timestamp.fromDate(context.receivedAt),
        ...(lastEventAt === null ? {} : { lastEventAt: Timestamp.fromDate(lastEventAt) }),
        ...(context.bridgeVersion === undefined ? {} : { bridgeVersion: context.bridgeVersion }),
        connectionStatus: "online",
      }, { merge: true });
      return { accepted, duplicates };
    });
  }

  async recordContact(
    registration: DeviceRegistration,
    status: BridgeStatus | undefined,
    context: EventWriteContext,
  ): Promise<void> {
    const lastSuccessfulDevicePoll = status?.lastSuccessfulDevicePoll === undefined ? undefined :
      Timestamp.fromDate(new Date(status.lastSuccessfulDevicePoll));
    await this.db.doc(registration.deviceDocumentPath).set({
      lastSeen: Timestamp.fromDate(context.receivedAt),
      connectionStatus: status?.deviceConnected === false ? "offline" : "online",
      ...(status === undefined ? {} : { pendingLocalEvents: status.pendingEvents }),
      ...(lastSuccessfulDevicePoll === undefined ? {} : { lastSuccessfulDevicePoll }),
      ...(status?.deviceModel === undefined || status.deviceModel === "" ? {} : { deviceModel: status.deviceModel }),
      ...(status?.deviceSerial === undefined || status.deviceSerial === "" ? {} : { deviceSerial: status.deviceSerial }),
      ...(status?.firmwareVersion === undefined || status.firmwareVersion === "" ? {} : { firmwareVersion: status.firmwareVersion }),
      ...(context.bridgeVersion === undefined ? {} : { bridgeVersion: context.bridgeVersion }),
    }, { merge: true });
  }

  private mappingByKey(snapshots: DocumentSnapshot[]): Map<string, IdentityMapping> {
    const result = new Map<string, IdentityMapping>();
    for (const snapshot of snapshots) {
      const employeeId = requiredString(snapshot.get("employeeId"));
      if (snapshot.exists && employeeId !== null) {
        result.set(snapshot.id, { employeeId, active: snapshot.get("active") === true });
      }
    }
    return result;
  }

  private eventDocument(
    registration: DeviceRegistration,
    event: NormalizedEvent,
    context: EventWriteContext,
    employeeId: string | undefined,
  ): Record<string, unknown> {
    return {
      id: event.id,
      organizationId: registration.organizationId,
      branchId: registration.branchId,
      deviceId: registration.deviceId,
      ...(event.deviceSerial === undefined ? {} : { deviceSerial: event.deviceSerial }),
      ...(event.serialNo === undefined ? {} : { serialNo: event.serialNo }),
      employeeNo: event.employeeNo ?? "",
      ...(employeeId === undefined ? {} : { employeeId }),
      deviceEmployeeName: event.name ?? "",
      eventTime: Timestamp.fromDate(new Date(event.eventTime)),
      major: event.major,
      minor: event.minor,
      attendanceStatus: event.attendanceStatus ?? "",
      verifyMode: event.currentVerifyMode ?? "",
      cardNo: event.cardNo ?? "",
      cardReaderNo: event.cardReaderNo ?? null,
      doorNo: event.doorNo ?? null,
      source: "hikvision",
      sourceEventId: event.id,
      raw: event.raw ?? null,
      bridgeReceivedAt: Timestamp.fromDate(new Date(event.receivedAt)),
      receivedAt: Timestamp.fromDate(context.receivedAt),
      ingestionRequestId: context.requestId,
      mappingStatusAtIngest: employeeId === undefined ? "unmapped" : "mapped",
    };
  }

  private writeUnmappedAggregates(
    transaction: Transaction,
    organization: DocumentReference,
    registration: DeviceRegistration,
    aggregates: Map<string, UnmappedAggregate>,
    existing: Map<string, DocumentSnapshot>,
    context: EventWriteContext,
  ): void {
    for (const [key, aggregate] of aggregates) {
      const ref = organization.collection("unmappedIdentities").doc(key);
      const snapshot = existing.get(key);
      const firstSeenAt = snapshot?.exists === true && snapshot.get("firstSeenAt") instanceof Timestamp ?
        snapshot.get("firstSeenAt") as Timestamp : Timestamp.fromDate(aggregate.firstEventTime);
      transaction.set(ref, {
        organizationId: registration.organizationId,
        branchId: registration.branchId,
        deviceId: registration.deviceId,
        employeeNo: aggregate.employeeNo,
        state: "unmapped",
        eventCount: FieldValue.increment(aggregate.count),
        firstSeenAt,
        lastSeenAt: Timestamp.fromDate(aggregate.lastEventTime),
        updatedAt: Timestamp.fromDate(context.receivedAt),
      }, { merge: true });
    }
  }
}

export { identityKey };
