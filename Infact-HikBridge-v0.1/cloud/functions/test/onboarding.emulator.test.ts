import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { HttpsError } from "firebase-functions/v2/https";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { bootstrapOrganizationInFirestore, type BootstrapOrganizationInput } from "../src/onboarding/bootstrap.js";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const run = emulatorHost === undefined ? describe.skip : describe;
const projectId = "demo-hikbridge";
const app = initializeApp({ projectId }, `onboarding-${projectId}`);
const db = getFirestore(app);
const input: BootstrapOrganizationInput = {
  organizationId: "org-onboarding",
  organizationName: "Onboarding Test",
  timezone: "Asia/Colombo",
  branchId: "colombo",
  branchName: "Colombo HQ",
  shiftId: "NORMAL",
  shiftName: "Normal Shift",
  startTime: "08:30",
  endTime: "17:30",
  workingDays: [1, 2, 3, 4, 5],
  gracePeriodMinutes: 10,
  breakMinutes: 60,
  lateCalculationMode: "after_grace",
  missingPunchPolicy: "flag_exception",
};

run("organization onboarding", () => {
  beforeEach(async () => {
    await db.recursiveDelete(db.collection("organizations").doc(input.organizationId));
    await db.doc("users/owner-1").delete();
    await db.doc("users/owner-2").delete();
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  it("creates the profile, owner membership, branch, and default shift atomically", async () => {
    const result = await bootstrapOrganizationInFirestore(db, {
      uid: "owner-1",
      token: { email: "owner@example.com", name: "Owner One" },
    }, input);
    const [user, organization, member, branch, shift] = await Promise.all([
      db.doc("users/owner-1").get(),
      db.doc(`organizations/${input.organizationId}`).get(),
      db.doc(`organizations/${input.organizationId}/members/owner-1`).get(),
      db.doc(`organizations/${input.organizationId}/branches/colombo`).get(),
      db.doc(`organizations/${input.organizationId}/shifts/NORMAL`).get(),
    ]);

    expect(result.role).toBe("organizationOwner");
    expect(user.get("defaultOrganizationId")).toBe(input.organizationId);
    expect(organization.get("timezone")).toBe("Asia/Colombo");
    expect(member.data()).toMatchObject({ role: "organizationOwner", active: true, branchIds: ["colombo"] });
    expect(branch.get("status")).toBe("active");
    expect(shift.data()).toMatchObject({ startTime: "08:30", endTime: "17:30", active: true });
  });

  it("refuses a second organization for the same user", async () => {
    const auth = { uid: "owner-1", token: { email: "owner@example.com" } };
    await bootstrapOrganizationInFirestore(db, auth, input);
    await expect(bootstrapOrganizationInFirestore(db, auth, { ...input, organizationId: "another-org" }))
      .rejects.toMatchObject({ code: "failed-precondition" } satisfies Partial<HttpsError>);
  });

  it("refuses to claim an existing organization identifier", async () => {
    await bootstrapOrganizationInFirestore(db, { uid: "owner-1", token: {} }, input);
    await expect(bootstrapOrganizationInFirestore(db, { uid: "owner-2", token: {} }, input))
      .rejects.toMatchObject({ code: "already-exists" } satisfies Partial<HttpsError>);
    expect((await db.doc("users/owner-2").get()).exists).toBe(false);
  });
});
