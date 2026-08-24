import { describe, expect, it } from "vitest";

import { computeSignature } from "../src/ingest/protocol.js";

describe("HikBridge protocol", () => {
  it("matches the Go bridge signature vector", () => {
    const signature = computeSignature(
      Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
      "office-main-01",
      "1787494635",
      "00112233445566778899aabbccddeeff",
      Buffer.from('{"deviceId":"office-main-01","events":[]}', "utf8"),
    );
    expect(signature).toBe("37e87a76af464598fe05713fa85b7b75de949e865c5ef82947a6329d9d0506c7");
  });
});
