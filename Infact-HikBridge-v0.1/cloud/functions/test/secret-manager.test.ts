import { describe, expect, it } from "vitest";

import { SecretManagerBridgeSecrets } from "../src/ingest/secret-manager.js";
import type { DeviceRegistration } from "../src/ingest/types.js";

const registration: DeviceRegistration = {
  deviceId: "device-1",
  organizationId: "org-1",
  branchId: "branch-1",
  deviceDocumentPath: "organizations/org-1/devices/device-1",
  enabled: true,
  secretVersionNames: ["projects/test/secrets/device/versions/1"],
};

describe("SecretManagerBridgeSecrets", () => {
  it("deduplicates concurrent reads and refreshes after the bounded TTL", async () => {
    let calls = 0;
    let now = 1_000;
    const client = {
      async accessSecretVersion(): Promise<[{ payload: { data: Buffer } }, ...unknown[]]> {
        calls++;
        return [{ payload: { data: Buffer.from("0123456789abcdef0123456789abcdef") } }];
      },
    };
    const provider = new SecretManagerBridgeSecrets(client, 5_000, 10, () => now);
    const [first, concurrent] = await Promise.all([provider.getSecrets(registration), provider.getSecrets(registration)]);
    expect(first[0]?.toString()).toBe("0123456789abcdef0123456789abcdef");
    expect(concurrent[0]?.toString()).toBe(first[0]?.toString());
    expect(calls).toBe(1);

    await provider.getSecrets(registration);
    expect(calls).toBe(1);
    now += 5_001;
    await provider.getSecrets(registration);
    expect(calls).toBe(2);
  });
});
