import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

import type { BridgeSecretProvider, DeviceRegistration } from "./types.js";

interface SecretManagerLike {
  accessSecretVersion(request: { name: string }): Promise<[{
    payload?: { data?: Uint8Array | string | null } | null;
  }, ...unknown[]]>;
}

interface CachedSecret {
  expiresAt: number;
  value: Buffer;
}

export class SecretManagerBridgeSecrets implements BridgeSecretProvider {
  private readonly cache = new Map<string, CachedSecret>();
  private readonly pending = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly client: SecretManagerLike = new SecretManagerServiceClient(),
    private readonly ttlMilliseconds = 5 * 60 * 1000,
    private readonly maximumEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  async getSecrets(registration: DeviceRegistration): Promise<Buffer[]> {
    return Promise.all(registration.secretVersionNames.map((name) => this.getSecret(name)));
  }

  private async getSecret(name: string): Promise<Buffer> {
    const cached = this.cache.get(name);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cached.value;
    }
    const inFlight = this.pending.get(name);
    if (inFlight !== undefined) return inFlight;
    const request = this.loadSecret(name);
    this.pending.set(name, request);
    try {
      const value = await request;
      if (this.cache.size >= this.maximumEntries && !this.cache.has(name)) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.delete(name);
      this.cache.set(name, { value, expiresAt: this.now() + this.ttlMilliseconds });
      return value;
    } finally {
      this.pending.delete(name);
    }
  }

  private async loadSecret(name: string): Promise<Buffer> {
    const [version] = await this.client.accessSecretVersion({ name });
    const data = version?.payload?.data;
    if (data === undefined || data === null) {
      throw new Error(`Secret Manager version ${name} has no payload`);
    }
    const secret = Buffer.from(data);
    if (secret.length < 32) {
      throw new Error(`Secret Manager version ${name} contains an invalid bridge secret`);
    }
    return secret;
  }
}
