const unavailableMessage = "The HikBridge installer is not available for this deployment. Contact your Infact administrator.";

function installerUrl(): URL | null {
  const configured = process.env.HIKBRIDGE_INSTALLER_URL?.trim();
  if (!configured) return null;

  try {
    const parsed = new URL(configured);
    return parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

export function GET() {
  const target = installerUrl();
  if (target === null) {
    return new Response(unavailableMessage, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  return new Response(null, {
    status: 307,
    headers: {
      "Cache-Control": "no-store",
      Location: target.toString(),
    },
  });
}
