import { deleteApp, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recalculateAttendance } from "../src/attendance/recalculation.js";
import { resolveShiftInferenceInFirestore } from "../src/shifts/inference-management.js";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const run = emulatorHost === undefined ? describe.skip : describe;
const projectId = "demo-hikbridge";
const app = initializeApp({ projectId }, `attendance-recalc-${projectId}`);
const db = getFirestore(app);
const organizationId = "org-recalc";
const employeeId = "employee-1";
const organization = db.collection("organizations").doc(organizationId);

async function seed(): Promise<void> {
  await organization.set({ name: "Test Organization", timezone: "Asia/Colombo" });
  await organization.collection("members").doc("owner-1").set({ role: "organizationOwner", active: true });
  await organization.collection("employees").doc(employeeId).set({
    name: "Test Employee",
    branchId: "branch-1",
  });
  await organization.collection("shifts").doc("NORMAL").set({
    name: "Normal Shift",
    startTime: "08:30",
    endTime: "17:30",
    workingDays: [1, 2, 3, 4, 5, 6, 7],
    gracePeriodMinutes: 10,
    lateCalculationMode: "after_grace",
    breakMinutes: 60,
    punchMode: "first_last",
    earlyLeave: { graceMinutes: 0 },
    overtime: {
      enabled: true,
      startDelayMinutes: 15,
      minimumMinutes: 30,
      roundingMinutes: 15,
      roundingMode: "floor",
    },
    active: true,
  });
  await organization.collection("shifts").doc("LATE").set({
    name: "Late Shift",
    startTime: "10:00",
    endTime: "19:00",
    workingDays: [1, 2, 3, 4, 5, 6, 7],
    gracePeriodMinutes: 10,
    lateCalculationMode: "after_grace",
    breakMinutes: 60,
    punchMode: "first_last",
    earlyLeave: { graceMinutes: 0 },
    overtime: { enabled: false, startDelayMinutes: 0, minimumMinutes: 0, roundingMinutes: 1, roundingMode: "none" },
    active: true,
  });
  await organization.collection("shiftAssignments").doc("assignment-1").set({
    employeeId,
    shiftId: "NORMAL",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  });
  await organization.collection("attendanceEvents").doc("event-in").set({
    employeeId,
    eventTime: Timestamp.fromDate(new Date("2026-08-23T03:17:00Z")),
    attendanceStatus: "checkIn",
    raw: { immutable: true },
  });
}

run("Firestore attendance recalculation", () => {
  beforeAll(seed);

  afterAll(async () => {
    await deleteApp(app);
  });

  it("is repeat-safe and does not mutate raw events", async () => {
    const beforeRaw = (await organization.collection("attendanceEvents").doc("event-in").get()).data();
    const first = await recalculateAttendance(db, organizationId, employeeId, "2026-08-23");
    const second = await recalculateAttendance(db, organizationId, employeeId, "2026-08-23");
    const afterRaw = (await organization.collection("attendanceEvents").doc("event-in").get()).data();

    expect(first).toEqual(second);
    expect(first.firstIn).toBe("08:47");
    expect(first.exceptions).toContain("missing_check_out");
    expect(afterRaw).toEqual(beforeRaw);
  });

  it("replaces the derived day when an offline punch arrives later", async () => {
    await organization.collection("attendanceEvents").doc("event-out").set({
      employeeId,
      eventTime: Timestamp.fromDate(new Date("2026-08-23T12:52:00Z")),
      attendanceStatus: "checkOut",
      raw: { immutable: true },
    });
    const result = await recalculateAttendance(db, organizationId, employeeId, "2026-08-23");
    const projection = await organization.collection("attendanceDays").doc(`${employeeId}_2026-08-23`).get();

    expect(result.lastOut).toBe("18:22");
    expect(result.exceptions).not.toContain("missing_check_out");
    expect(projection.get("calculationVersion")).toBe("attendance-v2");
    expect(projection.get("sourceEventIds")).toEqual(["event-in", "event-out"]);
  });

  it("applies an approved adjustment while leaving device events unchanged", async () => {
    const eventBefore = (await organization.collection("attendanceEvents").doc("event-out").get()).data();
    await organization.collection("manualAdjustments").doc("adjustment-1").set({
      employeeId,
      date: "2026-08-23",
      kind: "set_last_out",
      occurredAt: Timestamp.fromDate(new Date("2026-08-23T12:05:00Z")),
      state: "approved",
    });
    const result = await recalculateAttendance(db, organizationId, employeeId, "2026-08-23");
    const eventAfter = (await organization.collection("attendanceEvents").doc("event-out").get()).data();

    expect(result.lastOut).toBe("17:35");
    expect(result.hasManualAdjustment).toBe(true);
    expect(eventAfter).toEqual(eventBefore);
  });

  it("applies a clear daily shift match without creating a permanent assignment", async () => {
    const inferredEmployeeId = "employee-inferred";
    await organization.collection("employees").doc(inferredEmployeeId).set({
      employeeCode: "AUTO-1",
      name: "Auto Employee",
      branchId: "branch-1",
    });
    await organization.collection("attendanceEvents").doc("event-auto").set({
      employeeId: inferredEmployeeId,
      eventTime: Timestamp.fromDate(new Date("2026-08-24T03:05:00Z")),
      attendanceStatus: "checkIn",
    });

    const result = await recalculateAttendance(db, organizationId, inferredEmployeeId, "2026-08-24");
    const projection = await organization.collection("attendanceDays").doc(`${inferredEmployeeId}_2026-08-24`).get();
    const inference = await organization.collection("shiftInferences").doc(`${inferredEmployeeId}_2026-08-24`).get();
    const assignments = await organization.collection("shiftAssignments").where("employeeId", "==", inferredEmployeeId).get();

    expect(result.shiftId).toBe("NORMAL");
    expect(projection.get("shiftSource")).toBe("automatic");
    expect(inference.data()).toMatchObject({ state: "auto_applied", confidence: "high", selectedShiftId: "NORMAL" });
    expect(assignments.size).toBe(0);
  });

  it("holds an ambiguous match for HR and recalculates after confirmation", async () => {
    const reviewEmployeeId = "employee-review";
    const inferenceId = `${reviewEmployeeId}_2026-08-24`;
    await organization.collection("employees").doc(reviewEmployeeId).set({
      employeeCode: "REVIEW-1",
      name: "Review Employee",
      branchId: "branch-1",
    });
    await organization.collection("attendanceEvents").doc("event-review").set({
      employeeId: reviewEmployeeId,
      eventTime: Timestamp.fromDate(new Date("2026-08-24T03:45:00Z")),
      attendanceStatus: "checkIn",
    });

    const pending = await recalculateAttendance(db, organizationId, reviewEmployeeId, "2026-08-24");
    expect(pending.shiftId).toBeNull();
    expect((await organization.collection("shiftInferences").doc(inferenceId).get()).get("state")).toBe("review_required");

    const resolution = await resolveShiftInferenceInFirestore(db, { uid: "owner-1", token: {} }, {
      organizationId,
      inferenceId,
      decision: "confirm",
      shiftId: "NORMAL",
      reason: "Confirmed against the employee roster",
    });
    const projection = await organization.collection("attendanceDays").doc(`${reviewEmployeeId}_2026-08-24`).get();
    const audits = await organization.collection("shiftInferenceAudits").where("inferenceId", "==", inferenceId).get();

    expect(resolution.state).toBe("confirmed");
    expect(projection.data()).toMatchObject({ shiftId: "NORMAL", shiftSource: "confirmed" });
    expect(audits.size).toBe(1);
  });
});
