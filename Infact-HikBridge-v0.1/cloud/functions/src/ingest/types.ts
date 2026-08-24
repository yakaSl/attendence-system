export const PROTOCOL_VERSION = "1";
export const MAX_BODY_BYTES = 1_048_576;
export const MAX_BATCH_SIZE = 100;
export const MAX_RAW_EVENT_BYTES = 65_536;
export const REQUEST_SKEW_SECONDS = 300;

export interface BridgeHeaders {
  version: string;
  deviceId: string;
  timestamp: string;
  timestampSeconds: number;
  nonce: string;
  signature: string;
}

export interface DeviceRegistration {
  deviceId: string;
  organizationId: string;
  branchId: string;
  deviceDocumentPath: string;
  enabled: boolean;
  secretVersionNames: string[];
}

export interface NormalizedEvent {
  id: string;
  deviceId: string;
  deviceSerial?: string | undefined;
  serialNo?: number | undefined;
  employeeNo?: string | undefined;
  name?: string | undefined;
  eventTime: string;
  major: number;
  minor: number;
  attendanceStatus?: string | undefined;
  currentVerifyMode?: string | undefined;
  cardNo?: string | undefined;
  cardReaderNo?: number | undefined;
  doorNo?: number | undefined;
  raw?: unknown;
  receivedAt: string;
}

export interface IngestEnvelope {
  protocolVersion: string;
  requestId: string;
  deviceId: string;
  probe: boolean;
  status?: BridgeStatus | undefined;
  events: unknown[];
}

export interface BridgeStatus {
  deviceConnected: boolean;
  lastSuccessfulDevicePoll?: string | undefined;
  pendingEvents: number;
  deviceModel?: string | undefined;
  deviceSerial?: string | undefined;
  firmwareVersion?: string | undefined;
}

export interface RejectedEvent {
  id: string;
  code: string;
  message?: string;
}

export interface EventWriteResult {
  accepted: string[];
  duplicates: string[];
}

export interface IngestResponse {
  protocolVersion: string;
  requestId: string;
  deviceId: string;
  organizationId: string;
  branchId: string;
  accepted: string[];
  duplicates: string[];
  rejected: RejectedEvent[];
}

export interface EventWriteContext {
  requestId: string;
  receivedAt: Date;
  bridgeVersion?: string | undefined;
}

export type ReplayClaim = "new" | "repeat" | "conflict";

export interface IngestRepository {
  getDevice(deviceId: string): Promise<DeviceRegistration | null>;
  claimReplay(
    registration: DeviceRegistration,
    nonce: string,
    bodyHash: string,
    receivedAt: Date,
  ): Promise<ReplayClaim>;
  writeEvents(
    registration: DeviceRegistration,
    events: NormalizedEvent[],
    context: EventWriteContext,
  ): Promise<EventWriteResult>;
  recordContact(
    registration: DeviceRegistration,
    status: BridgeStatus | undefined,
    context: EventWriteContext,
  ): Promise<void>;
}

export interface BridgeSecretProvider {
  getSecrets(registration: DeviceRegistration): Promise<Buffer[]>;
}

export type HeaderValue = string | string[] | undefined;
export type HeaderSource = Record<string, HeaderValue>;
