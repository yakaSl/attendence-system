import { httpsCallable } from "firebase/functions";

import type { BootstrapOrganizationRequest } from "../onboarding";
import type { BillingCycle, PlanId, PlanLimits } from "../billing/catalog";
import { firebaseFunctions, isDemoMode } from "./client";

async function call<Request, Response>(name: string, data: Request): Promise<Response> {
  if (isDemoMode()) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return { demo: true, request: data } as Response;
  }
  const result = await httpsCallable<Request, Response>(firebaseFunctions(), name)(data);
  return result.data;
}

export function mapDeviceIdentity(data: {
  organizationId: string;
  deviceId: string;
  employeeNo: string;
  employeeId: string;
  reason: string;
}) {
  return call<typeof data, { identityKey: string; employeeId: string; recalculationJobId: string }>("mapDeviceIdentity", data);
}

export function createEmployee(data: {
  organizationId: string;
  employeeCode: string;
  name: string;
  branchId: string;
  departmentId?: string | null;
  hireDate?: string;
  deviceId?: string | null;
}) {
  return call<typeof data, {
    employeeId: string;
    commandId: string | null;
    enrollmentId: string | null;
    signalDelivered: boolean;
  }>("createEmployee", data);
}

export function updateEmployeeDepartment(data: {
  organizationId: string;
  employeeId: string;
  departmentId: string | null;
  reason: string;
}) {
  return call<typeof data, { employeeId: string; departmentId: string | null }>("updateEmployeeDepartment", data);
}

export function requestFingerprintEnrollment(data: {
  organizationId: string;
  employeeId: string;
  deviceId: string;
  fingerPrintId: number;
}) {
  return call<typeof data, {
    commandId: string;
    employeeId: string;
    deviceId: string;
    enrollmentId: string;
    signalDelivered: boolean;
  }>("requestFingerprintEnrollment", data);
}

export function createManualAdjustment(data: {
  organizationId: string;
  employeeId: string;
  date: string;
  requestId: string;
  kind: "set_first_in" | "set_last_out" | "clear_first_in" | "clear_last_out" | "set_status";
  occurredAt?: string;
  status?: "present" | "absent" | "leave" | "holiday" | "rest_day" | "no_shift";
  reason: string;
}) {
  return call<typeof data, { adjustmentId: string }>("createManualAdjustment", data);
}

export function createBranch(data: {
  organizationId: string;
  branchId: string;
  name: string;
}) {
  return call<typeof data, { id: string; name: string; timezone: string; status: "active" }>("createBranch", data);
}

export function deleteBranch(data: {
  organizationId: string;
  branchId: string;
}) {
  return call<typeof data, { id: string; status: "inactive" }>("deleteBranch", data);
}

export function createDepartment(data: {
  organizationId: string;
  departmentId: string;
  name: string;
}) {
  return call<typeof data, { id: string; name: string }>("createDepartment", data);
}

export function provisionDevice(data: {
  organizationId: string;
  branchId: string;
  localDeviceId: string;
  name: string;
  deviceType: "hikvision_ds_k1a8503ef" | "hikvision_other";
  description?: string;
}) {
  if (isDemoMode()) {
    return Promise.resolve({
      deviceId: data.localDeviceId,
      bridgeKey: "demo-key-display-only-not-a-real-credential",
      config: { cloud: { enabled: true, bridgeKey: "demo-key-display-only-not-a-real-credential", batchSize: 100 } },
    });
  }
  return call<typeof data, { deviceId: string; bridgeKey: string; config: { cloud: { enabled: boolean; bridgeKey: string; batchSize: number } } }>("provisionDevice", data);
}

export function rotateDeviceCredential(data: { deviceId: string }) {
  if (isDemoMode()) return Promise.resolve({ deviceId: data.deviceId, bridgeKey: "demo-rotated-key-display-only", previousCredentialGraceMinutes: 15 });
  return call<typeof data, { deviceId: string; bridgeKey: string; previousCredentialGraceMinutes: number }>("rotateDeviceCredential", data);
}

export function setDeviceEnabled(data: { deviceId: string; enabled: boolean }) {
  return call<typeof data, { deviceId: string; enabled: boolean }>("setDeviceEnabled", data);
}

export function removeDevice(data: { deviceId: string; organizationId: string }) {
  if (isDemoMode()) {
    return Promise.resolve({ deviceId: data.deviceId, organizationId: "demo", removed: true as const, deletedBindings: 0 });
  }
  return call<typeof data, {
    deviceId: string;
    organizationId: string;
    removed: true;
    deletedBindings: number;
  }>("removeDevice", data);
}

export interface MergeDeviceEnrollmentDataResult {
  sourceDeviceId: string;
  targetDeviceId: string;
  organizationId: string;
  mappedIdentities: number;
  enrollmentRecords: number;
  resolvedUnmappedIdentities: number;
  serialVerified: boolean;
}

export function mergeDeviceEnrollmentData(data: {
  sourceDeviceId: string;
  targetDeviceId: string;
  confirmedSamePhysicalDevice: true;
}) {
  if (isDemoMode()) {
    return Promise.resolve({
      sourceDeviceId: data.sourceDeviceId,
      targetDeviceId: data.targetDeviceId,
      organizationId: "demo",
      mappedIdentities: 3,
      enrollmentRecords: 3,
      resolvedUnmappedIdentities: 0,
      serialVerified: true,
    } satisfies MergeDeviceEnrollmentDataResult);
  }
  return call<typeof data, MergeDeviceEnrollmentDataResult>("mergeDeviceEnrollmentData", data);
}

export function createSubscriptionCheckout(data: {
  organizationId: string;
  planId: PlanId;
  billingCycle: BillingCycle;
}) {
  if (isDemoMode()) return Promise.resolve({ checkoutUrl: "/subscribe/success?demo=1", reused: false });
  return call<typeof data, { checkoutUrl: string; reused: boolean }>("createSubscriptionCheckout", data);
}

export function createCustomerPortalSession(data: { organizationId: string }) {
  if (isDemoMode()) return Promise.resolve({ portalUrl: "/billing?demoPortal=1" });
  return call<typeof data, { portalUrl: string }>("createCustomerPortalSession", data);
}

export interface CurrentSubscriptionPayload {
  organizationId: string;
  planId: PlanId;
  planName: string;
  billingCycle: BillingCycle;
  billingStatus: string;
  accessStatus: "active" | "restricted";
  source: "dodo" | "manual" | "complimentary";
  currency: "LKR";
  priceLkr: number;
  limits: PlanLimits;
  currentPeriodEnd: string | null;
  endsAt: string | null;
  cancelAtPeriodEnd: boolean;
}

export function getCurrentSubscription() {
  if (isDemoMode()) return Promise.resolve({ organizationId: null, subscription: null });
  return call<Record<string, never>, {
    organizationId: string | null;
    subscription: CurrentSubscriptionPayload | null;
  }>("getCurrentSubscription", {});
}

export interface PlatformSubscriptionRow {
  organizationId: string;
  organizationName: string;
  planId: string | null;
  planName: string | null;
  billingCycle: string | null;
  billingStatus: string | null;
  accessStatus: string | null;
  source: string | null;
  startsAt: string | null;
  endsAt: string | null;
  currentPeriodEnd: string | null;
  updatedAt: string | null;
}

export function listPlatformSubscriptions() {
  if (isDemoMode()) return Promise.resolve({ subscriptions: [] as PlatformSubscriptionRow[] });
  return call<Record<string, never>, { subscriptions: PlatformSubscriptionRow[] }>("listPlatformSubscriptions", {});
}

export function configureBillingProduct(data: {
  planId: PlanId;
  billingCycle: BillingCycle;
  dodoProductId: string;
  enabled: boolean;
}) {
  return call<typeof data, { planId: PlanId; billingCycle: BillingCycle; enabled: boolean }>("configureBillingProduct", data);
}

export function activateManualSubscription(data: {
  organizationId: string;
  planId: PlanId;
  billingCycle: BillingCycle;
  startsAt?: string;
  endsAt?: string | null;
  reason: string;
}) {
  return call<typeof data, { organizationId: string; accessStatus: "active" }>("activateManualSubscription", data);
}

export function setSubscriptionStatus(data: {
  organizationId: string;
  action: "pause" | "resume" | "cancel";
  reason: string;
}) {
  return call<typeof data, { organizationId: string; billingStatus: string; accessStatus: string }>("setSubscriptionStatus", data);
}

export function saveShift(data: {
  organizationId: string;
  shiftId: string;
  name: string;
  startTime: string;
  endTime: string;
  workingDays: number[];
  gracePeriodMinutes: number;
  lateCalculationMode: "from_shift_start" | "after_grace";
  breakMinutes: number;
  punchMode: "first_last" | "explicit_status";
  earlyLeaveGraceMinutes: number;
  overtimeEnabled: boolean;
  overtimeStartDelayMinutes: number;
  overtimeMinimumMinutes: number;
  overtimeRoundingMinutes: number;
  overtimeRoundingMode: "none" | "floor" | "nearest" | "ceil";
  active: boolean;
  recalculateFrom: string;
  reason: string;
}) {
  return call<typeof data, { shiftId: string; recalculationJobId: string }>("saveShift", data);
}

export function assignEmployeeShift(data: {
  organizationId: string;
  employeeId: string;
  shiftId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
}) {
  return call<typeof data, { assignmentId: string; recalculationJobId: string }>("assignEmployeeShift", data);
}

export function resolveShiftInference(data: {
  organizationId: string;
  inferenceId: string;
  decision: "confirm" | "reject";
  shiftId: string | null;
  reason: string;
}) {
  return call<typeof data, { inferenceId: string; state: "confirmed" | "rejected" }>("resolveShiftInference", data);
}

export async function bootstrapOrganization(data: BootstrapOrganizationRequest): Promise<{
  organizationId: string;
  branchId: string;
  shiftId: string;
  role: "organizationOwner";
}> {
  if (isDemoMode()) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return { organizationId: data.organizationId, branchId: data.branchId, shiftId: data.shiftId, role: "organizationOwner" };
  }
  return call<BootstrapOrganizationRequest, {
    organizationId: string;
    branchId: string;
    shiftId: string;
    role: "organizationOwner";
  }>("bootstrapOrganization", data);
}
