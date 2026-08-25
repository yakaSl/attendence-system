import { afterEach, describe, expect, it } from "vitest";

import { GET } from "../src/app/downloads/hikbridge/update/route";

const originalLatestVersion = process.env.HIKBRIDGE_LATEST_VERSION;
const originalInstallerUrl = process.env.HIKBRIDGE_INSTALLER_URL;
const originalReleaseNotesUrl = process.env.HIKBRIDGE_RELEASE_NOTES_URL;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("HIKBRIDGE_LATEST_VERSION", originalLatestVersion);
  restore("HIKBRIDGE_INSTALLER_URL", originalInstallerUrl);
  restore("HIKBRIDGE_RELEASE_NOTES_URL", originalReleaseNotesUrl);
});

function request() {
  return new Request("https://pulse.example.com/downloads/hikbridge/update");
}

describe("HikBridge update manifest", () => {
  it("fails closed when the release is not fully configured", () => {
    delete process.env.HIKBRIDGE_LATEST_VERSION;
    process.env.HIKBRIDGE_INSTALLER_URL = "https://downloads.example.com/Infact-HikBridge-Setup-0.2.0.exe";

    const response = GET(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects invalid versions and insecure installer URLs", () => {
    process.env.HIKBRIDGE_LATEST_VERSION = "version-two";
    process.env.HIKBRIDGE_INSTALLER_URL = "https://downloads.example.com/HikBridge.exe";
    expect(GET(request()).status).toBe(503);

    process.env.HIKBRIDGE_LATEST_VERSION = "0.2.0-01";
    process.env.HIKBRIDGE_INSTALLER_URL = "https://downloads.example.com/HikBridge.exe";
    expect(GET(request()).status).toBe(503);

    process.env.HIKBRIDGE_LATEST_VERSION = "0.2.0";
    process.env.HIKBRIDGE_INSTALLER_URL = "http://downloads.example.com/HikBridge.exe";
    expect(GET(request()).status).toBe(503);
  });

  it("publishes the current release and stable download path", async () => {
    process.env.HIKBRIDGE_LATEST_VERSION = "0.2.0";
    process.env.HIKBRIDGE_INSTALLER_URL = "https://downloads.example.com/Infact-HikBridge-Setup-0.2.0.exe";
    process.env.HIKBRIDGE_RELEASE_NOTES_URL = "https://pulse.example.com/releases/0.2.0";

    const response = GET(request());
    const manifest = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=300");
    expect(manifest).toEqual({
      version: "0.2.0",
      downloadUrl: "https://pulse.example.com/downloads/hikbridge",
      releaseNotesUrl: "https://pulse.example.com/releases/0.2.0",
    });
  });
});
