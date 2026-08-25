import { createHash, randomBytes, randomUUID } from "node:crypto";

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { getApp } from "firebase-admin/app";
import { Timestamp, type Firestore, type Query } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

import { requireAuthentication, requireOrganizationRole, type AuthContext } from "../authz.js";
import { assertCreationWithinLimit } from "../billing/entitlements.js";
import { firestore } from "../firebase.js";

const region = "asia-south1";
const deviceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const provisionSchema = z.object({
  organizationId: z.string().min(1).max(128),
  branchId: z.string().min(1).max(128),
  localDeviceId: z.string().regex(deviceIdPattern),
  name: z.string().trim().min(1).max(120),
  deviceType: z.enum(["hikvision_ds_k1a8503ef", "hikvision_other"]),
  description: z.string().trim().max(500).optional(),
}).strict();

export const deviceActionSchema = z.object({
  deviceId: z.string().regex(deviceIdPattern),
}).strict();

export const removeDeviceSchema = deviceActionSchema.extend({
  organizationId: z.string().min(1).max(128).refine((value) => !value.includes("/"), "Organization ID is invalid").optional(),
}).strict();

const enabledSchema = deviceActionSchema.extend({ enabled: z.boolean() }).strict();

interface SecretManagerLike {
  createSecret(request: {
    parent: string;
    secretId: string;
    secret: { replication: { automatic: Record<string, never> }; labels: Record<string, string> };
  }): Promise<[{ name?: string | null }, ...unknown[]]>;
  addSecretVersion(request: {
    parent: string;
    payload: { data: Buffer };
  }): Promise<[{ name?: string | null }, ...unknown[]]>;
  deleteSecret(request: { name: string }): Promise<unknown>;
}

function projectId(): string {
  const value = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? getApp().options.projectId;
  if (value === undefined || value === "") {
    throw new Error("Firebase/Google Cloud project ID is unavailable");
  }
  return value;
}

function secretId(deviceId: string): string {
  const digest = createHash("sha256").update(deviceId, "utf8").digest("hex").slice(0, 32);
  return `hikbridge-${digest}`;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 6;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === 5 || error.code === "5" || error.code === "NOT_FOUND";
}

async function deleteQueryDocuments(db: Firestore, query: Query): Promise<number> {
  let deleted = 0;
  while (true) {
    const snapshot = await query.limit(200).get();
    if (snapshot.empty) return deleted;
    const batch = db.batch();
    for (const document of snapshot.docs) batch.delete(document.ref);
    await batch.commit();
    deleted += snapshot.size;
  }
}

export class DeviceProvisioningService {
  constructor(
    private readonly db: Firestore,
    private readonly secrets: SecretManagerLike,
  ) {}

  async provision(raw: unknown, authContext: AuthContext): Promise<Record<string, unknown>> {
    const parsed = provisionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", "Device provisioning fields are invalid");
    }
    const input = parsed.data;
    await requireOrganizationRole(this.db, authContext, input.organizationId, ["organizationOwner", "hrAdmin"]);
    const registry = this.db.collection("bridgeDeviceRegistry").doc(input.localDeviceId);
    const organization = this.db.collection("organizations").doc(input.organizationId);
    const branch = organization.collection("branches").doc(input.branchId);
    const device = organization.collection("devices").doc(input.localDeviceId);
    const reservation = randomUUID();
    const now = Timestamp.now();
    let retryingFailedProvision = false;

    await this.db.runTransaction(async (transaction) => {
      await assertCreationWithinLimit(
        transaction,
        this.db,
        input.organizationId,
        "devices",
        organization.collection("devices").where("enabled", "==", true),
      );
      const [organizationSnapshot, branchSnapshot, registrySnapshot] = await transaction.getAll(organization, branch, registry);
      if (organizationSnapshot === undefined || branchSnapshot === undefined || registrySnapshot === undefined) {
        throw new Error("Provisioning transaction did not return every requested document");
      }
      if (!organizationSnapshot.exists || !branchSnapshot.exists) {
        throw new HttpsError("not-found", "Organization or branch does not exist");
      }
      if (registrySnapshot.exists && (
        registrySnapshot.get("state") !== "provisioning_failed" ||
        registrySnapshot.get("organizationId") !== input.organizationId
      )) {
        throw new HttpsError("already-exists", "This bridge device ID is already registered");
      }
      const reservationData = {
        state: "provisioning",
        reservation,
        organizationId: input.organizationId,
        branchId: input.branchId,
        deviceDocumentPath: device.path,
        enabled: false,
        createdAt: now,
        createdBy: authContext.uid,
      };
      if (registrySnapshot.exists) {
        retryingFailedProvision = true;
        transaction.set(registry, reservationData);
      } else {
        transaction.create(registry, reservationData);
      }
    });

    const bridgeKey = randomBytes(32).toString("base64url");
    const secretManagerId = secretId(input.localDeviceId);
    const secretResourceName = `projects/${projectId()}/secrets/${secretManagerId}`;
    try {
      let createdSecretName = secretResourceName;
      try {
        const [secret] = await this.secrets.createSecret({
          parent: `projects/${projectId()}`,
          secretId: secretManagerId,
          secret: {
            replication: { automatic: {} },
            labels: { application: "infact-hikbridge" },
          },
        });
        if (secret.name === undefined || secret.name === null || secret.name === "") {
          throw new Error("Secret Manager did not return a secret resource name");
        }
        createdSecretName = secret.name;
      } catch (error) {
        if (!retryingFailedProvision || !isAlreadyExists(error)) throw error;
      }
      const [version] = await this.secrets.addSecretVersion({
        parent: createdSecretName,
        payload: { data: Buffer.from(bridgeKey, "utf8") },
      });
      if (version.name === undefined || version.name === null || version.name === "") {
        throw new Error("Secret Manager did not return a version resource name");
      }
      await this.db.runTransaction(async (transaction) => {
        const reservationSnapshot = await transaction.get(registry);
        if (reservationSnapshot.get("reservation") !== reservation) {
          throw new Error("Device provisioning reservation changed unexpectedly");
        }
        transaction.set(device, {
          id: input.localDeviceId,
          organizationId: input.organizationId,
          branchId: input.branchId,
          localDeviceId: input.localDeviceId,
          name: input.name,
          deviceType: input.deviceType,
          description: input.description ?? "",
          connectionStatus: "provisioned",
          enabled: true,
          createdAt: now,
          createdBy: authContext.uid,
          updatedAt: now,
        });
        transaction.update(registry, {
          state: "active",
          enabled: true,
          secretResourceName: createdSecretName,
          secretVersionNames: [version.name],
          activatedAt: now,
          reservation: null,
        });
      });
    } catch (error) {
      await registry.set({
        state: "provisioning_failed",
        enabled: false,
        failedAt: Timestamp.now(),
      }, { merge: true });
      throw error;
    }

    // bridgeKey is deliberately returned only by this creation call.
    return {
      deviceId: input.localDeviceId,
      bridgeKey,
      organizationId: input.organizationId,
      branchId: input.branchId,
      config: {
        cloud: {
          enabled: true,
          bridgeKey,
          batchSize: 100,
        },
      },
    };
  }

  async rotate(raw: unknown, authContext: AuthContext): Promise<Record<string, unknown>> {
    const parsed = deviceActionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", "Device ID is invalid");
    }
    const registry = this.db.collection("bridgeDeviceRegistry").doc(parsed.data.deviceId);
    const snapshot = await registry.get();
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Device registration does not exist");
    }
    const organizationId = snapshot.get("organizationId");
    const secretResourceName = snapshot.get("secretResourceName");
    if (typeof organizationId !== "string" || typeof secretResourceName !== "string") {
      throw new Error("Device registration is incomplete");
    }
    await requireOrganizationRole(this.db, authContext, organizationId, ["organizationOwner", "hrAdmin"]);
    const bridgeKey = randomBytes(32).toString("base64url");
    const [version] = await this.secrets.addSecretVersion({
      parent: secretResourceName,
      payload: { data: Buffer.from(bridgeKey, "utf8") },
    });
    if (version.name === undefined || version.name === null || version.name === "") {
      throw new Error("Secret Manager did not return a version resource name");
    }
    const oldVersions = Array.isArray(snapshot.get("secretVersionNames")) ?
      (snapshot.get("secretVersionNames") as unknown[]).filter((value): value is string => typeof value === "string") : [];
    await registry.update({
      secretVersionNames: [version.name, ...oldVersions.slice(0, 1)],
      previousSecretValidUntil: Timestamp.fromMillis(Date.now() + 15 * 60 * 1000),
      rotatedAt: Timestamp.now(),
      rotatedBy: authContext.uid,
    });
    return { deviceId: parsed.data.deviceId, bridgeKey, previousCredentialGraceMinutes: 15 };
  }

  async setEnabled(raw: unknown, authContext: AuthContext): Promise<{ deviceId: string; enabled: boolean }> {
    const parsed = enabledSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", "Device action fields are invalid");
    }
    const registry = this.db.collection("bridgeDeviceRegistry").doc(parsed.data.deviceId);
    const snapshot = await registry.get();
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Device registration does not exist");
    }
    const organizationId = snapshot.get("organizationId");
    const deviceDocumentPath = snapshot.get("deviceDocumentPath");
    if (typeof organizationId !== "string" || typeof deviceDocumentPath !== "string") {
      throw new Error("Device registration is incomplete");
    }
    await requireOrganizationRole(this.db, authContext, organizationId, ["organizationOwner", "hrAdmin"]);
    const batch = this.db.batch();
    batch.update(registry, { enabled: parsed.data.enabled, updatedAt: Timestamp.now(), updatedBy: authContext.uid });
    batch.set(this.db.doc(deviceDocumentPath), { enabled: parsed.data.enabled, updatedAt: Timestamp.now() }, { merge: true });
    await batch.commit();
    return { deviceId: parsed.data.deviceId, enabled: parsed.data.enabled };
  }

  async remove(raw: unknown, authContext: AuthContext): Promise<{
    deviceId: string;
    organizationId: string;
    removed: true;
    deletedBindings: number;
  }> {
    const parsed = removeDeviceSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", "Device ID is invalid");
    }
    const deviceId = parsed.data.deviceId;
    const registry = this.db.collection("bridgeDeviceRegistry").doc(deviceId);
    const registrySnapshot = await registry.get();
    const registryInitiallyPresent = registrySnapshot.exists;
    const registeredOrganizationId = registrySnapshot.get("organizationId");
    const organizationId = registrySnapshot.exists ? registeredOrganizationId : parsed.data.organizationId;
    if (typeof organizationId !== "string" || organizationId.length === 0) {
      throw new HttpsError("not-found", "Device registration does not exist");
    }
    if (parsed.data.organizationId !== undefined && parsed.data.organizationId !== organizationId) {
      throw new HttpsError("permission-denied", "The device does not belong to this organization");
    }
    const deviceDocumentPath = `organizations/${organizationId}/devices/${deviceId}`;
    if (registrySnapshot.exists && registrySnapshot.get("deviceDocumentPath") !== deviceDocumentPath) {
      throw new HttpsError("failed-precondition", "Device registration is incomplete");
    }
    await requireOrganizationRole(this.db, authContext, organizationId, ["organizationOwner", "hrAdmin"]);

    const organization = this.db.collection("organizations").doc(organizationId);
    const device = this.db.doc(deviceDocumentPath);
    const now = Timestamp.now();
    let deviceName = deviceId;
    let branchId: string | null = null;
    let secretResourceName: string | null = null;

    // Revoke the bridge before deleting any supporting records. This leaves a
    // safe, retryable state if a later external cleanup step fails.
    await this.db.runTransaction(async (transaction) => {
      const [latestRegistry, deviceSnapshot] = await transaction.getAll(registry, device);
      if (latestRegistry === undefined || deviceSnapshot === undefined) {
        throw new Error("Device removal transaction did not return every requested document");
      }
      if (latestRegistry.exists && (
        latestRegistry.get("organizationId") !== organizationId ||
        latestRegistry.get("deviceDocumentPath") !== device.path
      )) {
        throw new HttpsError("failed-precondition", "Device registration changed during removal");
      }
      const storedName = deviceSnapshot?.get("name");
      const storedBranchId = latestRegistry.exists ? latestRegistry.get("branchId") : deviceSnapshot.get("branchId");
      const storedSecretResourceName = latestRegistry.get("secretResourceName");
      if (typeof storedName === "string" && storedName.length > 0) deviceName = storedName;
      if (typeof storedBranchId === "string" && storedBranchId.length > 0) branchId = storedBranchId;
      if (typeof storedSecretResourceName === "string" && storedSecretResourceName.length > 0) {
        secretResourceName = storedSecretResourceName;
      }
      const deletionState = {
        state: "deleting",
        enabled: false,
        organizationId,
        branchId,
        deviceDocumentPath: device.path,
        deletionRequestedAt: now,
        deletionRequestedBy: authContext.uid,
      };
      if (latestRegistry.exists) transaction.update(registry, deletionState);
      else transaction.create(registry, { ...deletionState, recoveredForDeletion: true });
      if (deviceSnapshot.exists) {
        transaction.set(device, {
          enabled: false,
          connectionStatus: "disabled",
          deletionRequestedAt: now,
          updatedAt: now,
        }, { merge: true });
      }
    });

    if (secretResourceName !== null) {
      try {
        await this.secrets.deleteSecret({ name: secretResourceName });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    const deletedBindings = (await Promise.all([
      deleteQueryDocuments(this.db, organization.collection("deviceIdentities").where("deviceId", "==", deviceId)),
      deleteQueryDocuments(this.db, organization.collection("unmappedIdentities").where("deviceId", "==", deviceId)),
      deleteQueryDocuments(this.db, organization.collection("deviceEnrollments").where("deviceId", "==", deviceId)),
      deleteQueryDocuments(this.db, this.db.collection("_bridgeReplay").where("deviceId", "==", deviceId)),
    ])).reduce((total, count) => total + count, 0);

    // recursiveDelete removes the device document and every command/lock
    // subcollection, including subcollections introduced by future features.
    await this.db.recursiveDelete(device);

    const audit = organization.collection("deviceDeletionAudits").doc();
    const finalBatch = this.db.batch();
    finalBatch.delete(registry);
    finalBatch.create(audit, {
      action: "device_removed",
      deviceId,
      deviceName,
      branchId,
      deletedBindings,
      registryRecoveredForDeletion: !registryInitiallyPresent,
      historicalAttendancePreserved: true,
      actorId: authContext.uid,
      createdAt: Timestamp.now(),
    });
    await finalBatch.commit();

    return { deviceId, organizationId, removed: true, deletedBindings };
  }
}

const provisioningService = new DeviceProvisioningService(firestore, new SecretManagerServiceClient());

export const provisionDevice = Object.assign(
  onCall({ region }, async (request) => {
    const auth = requireAuthentication(request.auth as AuthContext | undefined);
    return provisioningService.provision(request.data, auth);
  }),
  {
    __requiredAPIs: [{
      api: "secretmanager.googleapis.com",
      reason: "Stores and verifies HikBridge device credentials",
    }],
  },
);

export const rotateDeviceCredential = onCall({ region }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  return provisioningService.rotate(request.data, auth);
});

export const setDeviceEnabled = onCall({ region }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  return provisioningService.setEnabled(request.data, auth);
});

export const removeDevice = onCall({ region, timeoutSeconds: 120 }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  return provisioningService.remove(request.data, auth);
});
