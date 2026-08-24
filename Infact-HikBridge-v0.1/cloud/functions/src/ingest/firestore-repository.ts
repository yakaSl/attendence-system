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
  CommandExchangeResult,
  CommandResult,
  DeviceCommand,
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
      ...(status === undefined ? {} : { connectionStatus: status.deviceConnected ? "online" : "offline" }),
      ...(status === undefined ? {} : { pendingLocalEvents: status.pendingEvents }),
      ...(lastSuccessfulDevicePoll === undefined ? {} : { lastSuccessfulDevicePoll }),
      ...(status?.deviceModel === undefined || status.deviceModel === "" ? {} : { deviceModel: status.deviceModel }),
      ...(status?.deviceSerial === undefined || status.deviceSerial === "" ? {} : { deviceSerial: status.deviceSerial }),
      ...(status?.firmwareVersion === undefined || status.firmwareVersion === "" ? {} : { firmwareVersion: status.firmwareVersion }),
      ...(context.bridgeVersion === undefined ? {} : { bridgeVersion: context.bridgeVersion }),
    }, { merge: true });
  }

  async exchangeCommands(
    registration: DeviceRegistration,
    results: CommandResult[],
    context: EventWriteContext,
    deliver: boolean,
  ): Promise<CommandExchangeResult> {
    const organization = this.db.collection("organizations").doc(registration.organizationId);
    const device = organization.collection("devices").doc(registration.deviceId);
    const commands = device.collection("commands");
    const fingerprintLock = device.collection("commandLocks").doc("fingerprint");
    const acknowledgedCommandIds: string[] = [];
    const now = Timestamp.fromDate(context.receivedAt);

    if (results.length > 0) {
      const resultRefs = results.map((result) => commands.doc(result.commandId));
      await this.db.runTransaction(async (transaction) => {
        const allSnapshots = await transaction.getAll(...resultRefs, fingerprintLock);
        const snapshots = allSnapshots.slice(0, resultRefs.length);
        const lockSnapshot = allSnapshots[resultRefs.length];
        const enrollmentRefs = [...new Map(snapshots.flatMap((snapshot) => {
          if (!snapshot.exists) return [];
          const employeeNo = snapshot.get("employeeNo");
          if (typeof employeeNo !== "string") return [];
          const ref = organization.collection("deviceEnrollments").doc(identityKey(registration.deviceId, employeeNo));
          return [[ref.path, ref] as const];
        })).values()];
        const enrollmentSnapshots = enrollmentRefs.length === 0 ? [] : await transaction.getAll(...enrollmentRefs);
        const enrollmentByPath = new Map(enrollmentSnapshots.map((snapshot) => [snapshot.ref.path, snapshot]));
        for (const [index, snapshot] of snapshots.entries()) {
          const result = results[index];
          const ref = resultRefs[index];
          if (result === undefined || ref === undefined || !snapshot.exists) continue;
          if (snapshot.get("deviceId") !== registration.deviceId) continue;
          const currentState = snapshot.get("state");
          if (currentState !== "succeeded" && currentState !== "failed") {
            transaction.update(ref, {
              state: result.state,
              resultCode: result.code ?? null,
              resultMessage: result.message ?? null,
              result: result.output ?? null,
              completedAt: now,
              updatedAt: now,
            });
            const employeeId = snapshot.get("employeeId");
            const employeeNo = snapshot.get("employeeNo");
            const type = snapshot.get("type");
            if (type === "enroll_fingerprint" && lockSnapshot?.get("commandId") === result.commandId) {
              transaction.delete(fingerprintLock);
            }
            if (typeof employeeId === "string" && typeof employeeNo === "string") {
              const enrollment = organization.collection("deviceEnrollments").doc(identityKey(registration.deviceId, employeeNo));
              const currentEnrollment = enrollmentByPath.get(enrollment.path);
              const failed = result.state === "failed";
              const currentEnrollmentState = currentEnrollment?.get("state");
              const differentCurrentCommand = currentEnrollment?.exists === true &&
                currentEnrollment.get("commandId") !== result.commandId;
              const preserveFingerprintState = differentCurrentCommand && (type === "enroll_fingerprint" ||
                (type === "upsert_user" &&
                  (currentEnrollmentState === "queued" || currentEnrollmentState === "capturing" || currentEnrollmentState === "enrolled" ||
                    (currentEnrollmentState === "failed" && typeof currentEnrollment.get("fingerPrintId") === "number"))));
              if (preserveFingerprintState) {
                if (type === "upsert_user") {
                  transaction.set(enrollment, {
                    lastUserSyncError: failed ? result.message ?? result.code ?? "Device user sync failed" : null,
                    ...(!failed ? { userSyncedAt: now } : {}),
                  }, { merge: true });
                }
              } else {
                transaction.set(enrollment, {
                  organizationId: registration.organizationId,
                  branchId: registration.branchId,
                  deviceId: registration.deviceId,
                  employeeId,
                  employeeNo,
                  state: failed ? "failed" : type === "enroll_fingerprint" ? "enrolled" : "user_synced",
                  commandId: result.commandId,
                  lastError: failed ? result.message ?? result.code ?? "Device command failed" : null,
                  ...(type === "upsert_user" && !failed ? { userSyncedAt: now } : {}),
                  ...(type === "enroll_fingerprint" && !failed ? {
                    enrolledAt: now,
                    fingerPrintId: result.output?.fingerPrintId ?? snapshot.get("fingerPrintId") ?? 1,
                    quality: result.output?.quality ?? null,
                  } : {}),
                  updatedAt: now,
                }, { merge: true });
              }
            }
          }
          acknowledgedCommandIds.push(result.commandId);
        }
      });
    }

    if (!deliver) return { commands: [], acknowledgedCommandIds };
    const candidates = await commands.where("state", "in", ["queued", "dispatched"]).limit(20).get();
    if (candidates.empty) return { commands: [], acknowledgedCommandIds };

    const delivered = await this.db.runTransaction(async (transaction): Promise<DeviceCommand[]> => {
      const allSnapshots = await transaction.getAll(...candidates.docs.map((snapshot) => snapshot.ref), fingerprintLock);
      const snapshots = allSnapshots.slice(0, candidates.docs.length);
      const lockSnapshot = allSnapshots[candidates.docs.length];
      const enrollmentRefs = [...new Map(snapshots.flatMap((snapshot) => {
        if (!snapshot.exists) return [];
        const employeeNo = snapshot.get("employeeNo");
        if (typeof employeeNo !== "string") return [];
        const ref = organization.collection("deviceEnrollments").doc(identityKey(registration.deviceId, employeeNo));
        return [[ref.path, ref] as const];
      })).values()];
      const enrollmentSnapshots = enrollmentRefs.length === 0 ? [] : await transaction.getAll(...enrollmentRefs);
      const enrollmentByPath = new Map(enrollmentSnapshots.map((snapshot) => [snapshot.ref.path, snapshot]));
      const values: DeviceCommand[] = [];
      for (const snapshot of snapshots) {
        if (!snapshot.exists || snapshot.get("deviceId") !== registration.deviceId) continue;
        const state = snapshot.get("state");
        const leaseUntil = snapshot.get("leaseUntil");
        const expiresAt = snapshot.get("expiresAt");
        const expired = !(expiresAt instanceof Timestamp) || expiresAt.toMillis() <= context.receivedAt.getTime();
        const leaseActive = leaseUntil instanceof Timestamp && leaseUntil.toMillis() > context.receivedAt.getTime();
        if (expired) {
          transaction.update(snapshot.ref, { state: "failed", resultCode: "expired", resultMessage: "Command expired before delivery", completedAt: now, updatedAt: now });
          if (lockSnapshot?.get("commandId") === snapshot.id) transaction.delete(fingerprintLock);
          const expiredEmployeeNo = snapshot.get("employeeNo");
          if (typeof expiredEmployeeNo === "string") {
            const enrollment = organization.collection("deviceEnrollments").doc(identityKey(registration.deviceId, expiredEmployeeNo));
            if (enrollmentByPath.get(enrollment.path)?.get("commandId") === snapshot.id) {
              transaction.set(enrollment, {
                state: "failed",
                commandId: snapshot.id,
                lastError: "Command expired before delivery",
                updatedAt: now,
              }, { merge: true });
            }
          }
          continue;
        }
        if (state === "dispatched" && leaseActive) continue;
        const type = snapshot.get("type");
        const employeeId = snapshot.get("employeeId");
        const employeeNo = snapshot.get("employeeNo");
        const name = snapshot.get("name");
        const issuedAt = snapshot.get("createdAt");
        const fingerPrintId = snapshot.get("fingerPrintId");
        if ((type !== "upsert_user" && type !== "enroll_fingerprint") ||
            typeof employeeId !== "string" || typeof employeeNo !== "string" || typeof name !== "string" ||
            !(issuedAt instanceof Timestamp) ||
            (type === "enroll_fingerprint" &&
              (typeof fingerPrintId !== "number" || !Number.isInteger(fingerPrintId) || fingerPrintId < 1 || fingerPrintId > 10))) {
          transaction.update(snapshot.ref, { state: "failed", resultCode: "invalid_command", resultMessage: "Stored command is malformed", completedAt: now, updatedAt: now });
          if (lockSnapshot?.get("commandId") === snapshot.id) transaction.delete(fingerprintLock);
          if (typeof employeeNo === "string") {
            const enrollment = organization.collection("deviceEnrollments").doc(identityKey(registration.deviceId, employeeNo));
            if (enrollmentByPath.get(enrollment.path)?.get("commandId") === snapshot.id) {
              transaction.set(enrollment, {
                state: "failed",
                commandId: snapshot.id,
                lastError: "Stored command is malformed",
                updatedAt: now,
              }, { merge: true });
            }
          }
          continue;
        }
        // A terminal can display only one capture prompt at a time. Keep later
        // commands queued until this command has produced a durable result.
        if (values.length >= 1) continue;
        transaction.update(snapshot.ref, {
          state: "dispatched",
          leaseUntil: Timestamp.fromMillis(context.receivedAt.getTime() + 2 * 60 * 1000),
          lastDispatchedAt: now,
          attempts: FieldValue.increment(1),
          updatedAt: now,
        });
        if (type === "enroll_fingerprint") {
          transaction.set(organization.collection("deviceEnrollments").doc(identityKey(registration.deviceId, employeeNo)), {
            state: "capturing",
            commandId: snapshot.id,
            updatedAt: now,
          }, { merge: true });
        }
        values.push({
          id: snapshot.id,
          type,
          issuedAt: issuedAt.toDate().toISOString(),
          expiresAt: expiresAt.toDate().toISOString(),
          payload: {
            employeeId,
            employeeNo,
            name,
            ...(type === "enroll_fingerprint" && typeof fingerPrintId === "number" ? { fingerPrintId } : {}),
          },
        });
      }
      return values;
    });
    return { commands: delivered, acknowledgedCommandIds };
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
