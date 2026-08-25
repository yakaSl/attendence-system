import { afterEach, describe, expect, it } from "vitest";

import { GET } from "../src/app/downloads/hikbridge/route";

const originalInstallerUrl = process.env.HIKBRIDGE_INSTALLER_URL;

afterEach(() => {
  if (originalInstallerUrl === undefined) delete process.env.HIKBRIDGE_INSTALLER_URL;
  else process.env.HIKBRIDGE_INSTALLER_URL = originalInstallerUrl;
});

describe("HikBridge installer download", () => {
  it("fails closed when no signed installer URL is configured", () => {
    delete process.env.HIKBRIDGE_INSTALLER_URL;

    const response = GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects non-HTTPS installer locations", () => {
    process.env.HIKBRIDGE_INSTALLER_URL = "http://downloads.example.com/HikBridge.exe";

    expect(GET().status).toBe(503);
  });

  it("redirects to the configured signed installer", () => {
    process.env.HIKBRIDGE_INSTALLER_URL = "https://downloads.example.com/Infact-HikBridge-Setup-0.1.1.exe";

    const response = GET();

    expect(response.status).toBe(307);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(process.env.HIKBRIDGE_INSTALLER_URL);
  });
});
