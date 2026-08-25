import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

import { requireAuthentication, type AuthContext } from "../authz.js";
import { firestore } from "../firebase.js";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const shiftIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timezoneSchema = z.string().trim().min(1).max(100).refine((value) => {
  try {
    Intl.DateTimeFormat("en", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}, "Timezone must be a valid IANA name");

export const bootstrapOrganizationSchema = z.object({
  organizationId: idSchema,
  organizationName: z.string().trim().min(2).max(100),
  timezone: timezoneSchema,
  branchId: idSchema,
  branchName: z.string().trim().min(2).max(100),
  shiftId: shiftIdSchema,
  shiftName: z.string().trim().min(2).max(100),
  startTime: timeSchema,
  endTime: timeSchema,
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  gracePeriodMinutes: z.number().int().min(0).max(240),
  breakMinutes: z.number().int().min(0).max(480),
  lateCalculationMode: z.enum(["from_shift_start", "after_grace"]),
  missingPunchPolicy: z.literal("flag_exception"),
}).strict().superRefine((value, context) => {
  if (value.startTime === value.endTime) {
    context.addIssue({ code: "custom", message: "Shift start and end cannot match", path: ["endTime"] });
  }
  if (new Set(value.workingDays).size !== value.workingDays.length) {
    context.addIssue({ code: "custom", message: "Working days must be unique", path: ["workingDays"] });
  }
});

export type BootstrapOrganizationInput = z.infer<typeof bootstrapOrganizationSchema>;

export interface BootstrapOrganizationResult {
  organizationId: string;
  branchId: string;
  shiftId: string;
  role: "organizationOwner";
}

export async function bootstrapOrganizationInFirestore(
  db: Firestore,
  auth: AuthContext,
  input: BootstrapOrganizationInput,
): Promise<BootstrapOrganizationResult> {
  const user = db.doc(`users/${auth.uid}`);
  const organization = db.doc(`organizations/${input.organizationId}`);
  const member = organization.collection("members").doc(auth.uid);
  const branch = organization.collection("branches").doc(input.branchId);
  const shift = organization.collection("shifts").doc(input.shiftId);
  const audit = organization.collection("organizationCreationAudits").doc(auth.uid);
  const now = Timestamp.now();
  const displayName = typeof auth.token.name === "string" && auth.token.name.trim().length > 0 ?
    auth.token.name.trim() :
    typeof auth.token.email === "string" ? auth.token.email : "Organization Owner";

  await db.runTransaction(async (transaction) => {
    const [userSnapshot, organizationSnapshot] = await Promise.all([
      transaction.get(user),
      transaction.get(organization),
    ]);
    const currentOrganizationId = userSnapshot.get("defaultOrganizationId");
    if (typeof currentOrganizationId === "string" && currentOrganizationId.length > 0) {
      throw new HttpsError("failed-precondition", "This user already belongs to an organization");
    }
    if (organizationSnapshot.exists) {
      throw new HttpsError("already-exists", "That organization identifier is already in use");
    }

    transaction.create(organization, {
      name: input.organizationName,
      timezone: input.timezone,
      status: "active",
      primaryBranchId: input.branchId,
      defaultShiftId: input.shiftId,
      attendancePolicy: {
        lateMinutesMode: input.lateCalculationMode,
        missingPunchPolicy: input.missingPunchPolicy,
      },
      onboardingVersion: "onboarding-v1",
      createdAt: now,
      createdBy: auth.uid,
      updatedAt: now,
      updatedBy: auth.uid,
    });
    transaction.create(member, {
      role: "organizationOwner",
      active: true,
      branchIds: [input.branchId],
      createdAt: now,
      createdBy: auth.uid,
      updatedAt: now,
      updatedBy: auth.uid,
    });
    transaction.create(branch, {
      name: input.branchName,
      timezone: input.timezone,
      status: "active",
      createdAt: now,
      createdBy: auth.uid,
      updatedAt: now,
      updatedBy: auth.uid,
    });
    transaction.create(shift, {
      name: input.shiftName,
      startTime: input.startTime,
      endTime: input.endTime,
      workingDays: [...input.workingDays].sort(),
      gracePeriodMinutes: input.gracePeriodMinutes,
      lateCalculationMode: input.lateCalculationMode,
      breakMinutes: input.breakMinutes,
      punchMode: "first_last",
      earlyLeave: { graceMinutes: 0 },
      overtime: {
        enabled: false,
        startDelayMinutes: 0,
        minimumMinutes: 0,
        roundingMinutes: 1,
        roundingMode: "none",
      },
      active: true,
      createdAt: now,
      createdBy: auth.uid,
      updatedAt: now,
      updatedBy: auth.uid,
    });
    transaction.create(audit, {
      action: "organization_created",
      organizationId: input.organizationId,
      branchId: input.branchId,
      shiftId: input.shiftId,
      actorId: auth.uid,
      createdAt: now,
    });
    transaction.set(user, {
      displayName,
      ...(typeof auth.token.email === "string" ? { email: auth.token.email } : {}),
      defaultOrganizationId: input.organizationId,
      onboardingCompletedAt: now,
      onboardingVersion: "onboarding-v1",
      ...(userSnapshot.exists ? {} : { createdAt: now }),
      updatedAt: now,
    }, { merge: true });
  });

  return {
    organizationId: input.organizationId,
    branchId: input.branchId,
    shiftId: input.shiftId,
    role: "organizationOwner",
  };
}

export const bootstrapOrganization = onCall({
  region: "asia-south1",
  invoker: "public",
  timeoutSeconds: 30,
  memory: "256MiB",
  maxInstances: 20,
  concurrency: 20,
}, async (request) => {
  const auth = requireAuthentication(request.auth as AuthContext | undefined);
  const parsed = bootstrapOrganizationSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Organization setup fields are invalid");
  const result = await bootstrapOrganizationInFirestore(firestore, auth, parsed.data);
  logger.info("organization_onboarding_completed", {
    organizationId: result.organizationId,
    branchId: result.branchId,
    uid: auth.uid,
  });
  return result;
});
