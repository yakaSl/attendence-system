import { createHash, randomBytes, randomUUID } from "node:crypto";

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { getApp } from "firebase-admin/app";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

import { requireAuthentication, requireOrganizationRole, type AuthContext } from "../authz.js";
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

const deviceActionSchema = z.object({
  deviceId: z.string().regex(deviceIdPattern),
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

    await this.db.runTransaction(async (transaction) => {
      const [organizationSnapshot, branchSnapshot, registrySnapshot] = await transaction.getAll(organization, branch, registry);
      if (organizationSnapshot === undefined || branchSnapshot === undefined || registrySnapshot === undefined) {
        throw new Error("Provisioning transaction did not return every requested document");
      }
      if (!organizationSnapshot.exists || !branchSnapshot.exists) {
        throw new HttpsError("not-found", "Organization or branch does not exist");
      }
      if (registrySnapshot.exists) {
        throw new HttpsError("already-exists", "This bridge device ID is already registered");
      }
      transaction.create(registry, {
        state: "provisioning",
        reservation,
        organizationId: input.organizationId,
        branchId: input.branchId,
        deviceDocumentPath: device.path,
        enabled: false,
        createdAt: now,
        createdBy: authContext.uid,
      });
    });

    const bridgeKey = randomBytes(32).toString("base64url");
    const secretManagerId = secretId(input.localDeviceId);
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
      const [version] = await this.secrets.addSecretVersion({
        parent: secret.name,
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
          secretResourceName: secret.name,
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
}

const provisioningService = new DeviceProvisioningService(firestore, new SecretManagerServiceClient());

export const provisionDevice = onCall({ region }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  return provisioningService.provision(request.data, auth);
});

export const rotateDeviceCredential = onCall({ region }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  return provisioningService.rotate(request.data, auth);
});

export const setDeviceEnabled = onCall({ region }, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  return provisioningService.setEnabled(request.data, auth);
});
