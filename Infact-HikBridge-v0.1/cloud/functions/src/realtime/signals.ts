import { logger } from "firebase-functions";

import { bridgeRealtimeDatabase } from "../firebase.js";

const pathPartPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CommandSignal {
  organizationId: string;
  deviceId: string;
  commandId: string;
}

function safePathPart(label: string, value: string): string {
  if (!pathPartPattern.test(value)) throw new Error(`${label} is not safe for a Realtime Database path`);
  return value;
}

export async function signalDeviceCommand(signal: CommandSignal): Promise<boolean> {
  const organizationId = safePathPart("organizationId", signal.organizationId);
  const deviceId = safePathPart("deviceId", signal.deviceId);
  const commandId = safePathPart("commandId", signal.commandId);
  const updatedAt = Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await bridgeRealtimeDatabase().ref(
        `bridgeRealtime/v1/control/${organizationId}/${deviceId}`,
      ).set({
        commandId,
        revision: `${updatedAt}-${commandId}`,
        updatedAt,
      });
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
    }
  }
  // The Firestore command remains authoritative. The bridge's bounded
  // disconnected fallback will collect it even if all three wake attempts fail.
  logger.error("bridge_command_signal_failed", { organizationId, deviceId, commandId, error: lastError });
  return false;
}
