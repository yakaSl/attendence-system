import { deleteApp, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recalculateAttendance } from "../src/attendance/recalculation.js";

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
    expect(projection.get("calculationVersion")).toBe("attendance-v1");
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
});
