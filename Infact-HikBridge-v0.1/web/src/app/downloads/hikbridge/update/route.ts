const unavailableMessage = "The HikBridge update channel is not configured for this deployment.";
const semanticVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function validSemanticVersion(value: string): boolean {
  const match = semanticVersionPattern.exec(value);
  if (match === null) return false;
  return (match[4]?.split(".") ?? []).every((identifier) => !/^0[0-9]+$/.test(identifier));
}

function configuredHTTPS(name: string): URL | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" ? parsed : null;
  } catch {
    return null;
  }
}

function unavailable() {
  return new Response(unavailableMessage, {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export function GET(request: Request) {
  const version = process.env.HIKBRIDGE_LATEST_VERSION?.trim() ?? "";
  const installer = configuredHTTPS("HIKBRIDGE_INSTALLER_URL");
  const releaseNotesValue = process.env.HIKBRIDGE_RELEASE_NOTES_URL?.trim() ?? "";
  const releaseNotes = releaseNotesValue === "" ? null : configuredHTTPS("HIKBRIDGE_RELEASE_NOTES_URL");
  if (!validSemanticVersion(version) || installer === null || (releaseNotesValue !== "" && releaseNotes === null)) {
    return unavailable();
  }

  const downloadUrl = new URL("/downloads/hikbridge", request.url);
  if (downloadUrl.protocol !== "https:") return unavailable();
  return Response.json({
    version,
    downloadUrl: downloadUrl.toString(),
    ...(releaseNotes === null ? {} : { releaseNotesUrl: releaseNotes.toString() }),
  }, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}
