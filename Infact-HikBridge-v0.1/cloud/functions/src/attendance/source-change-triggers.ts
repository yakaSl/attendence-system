import { createHash } from "node:crypto";

import { Timestamp, type DocumentData, type DocumentReference, type DocumentSnapshot } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";

import { firestore } from "../firebase.js";

function string(snapshot: DocumentSnapshot | undefined, field: string): string | null {
  const value = snapshot?.exists === true ? snapshot.get(field) : null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jobId(eventId: string, suffix: string): string {
  return createHash("sha256").update(`${eventId}\0${suffix}`).digest("hex");
}

function earliest(...values: Array<string | null>): string | null {
  const present = values.filter((value): value is string => value !== null);
  return present.length === 0 ? null : present.sort()[0] ?? null;
}

function latest(...values: Array<string | null>): string | null {
  const present = values.filter((value): value is string => value !== null);
  return present.length === 0 ? null : present.sort().at(-1) ?? null;
}

async function createJobsIfAbsent(jobs: Array<{ ref: DocumentReference; data: DocumentData }>): Promise<void> {
  if (jobs.length === 0) return;
  await firestore.runTransaction(async (transaction) => {
    const snapshots = await transaction.getAll(...jobs.map((job) => job.ref));
    snapshots.forEach((snapshot, index) => {
      const job = jobs[index];
      if (!snapshot.exists && job !== undefined) transaction.create(job.ref, job.data);
    });
  });
}

export const recalculateLeaveChange = onDocumentWritten({
  document: "organizations/{organizationId}/leaveRequests/{leaveId}",
  region: "asia-south1",
  retry: true,
}, async (event) => {
  const before = event.data?.before;
  const after = event.data?.after;
  const beforeApproved = before?.exists === true && before.get("status") === "approved";
  const afterApproved = after?.exists === true && after.get("status") === "approved";
  if (!beforeApproved && !afterApproved) return;
  const employeeIds = new Set([
    ...(beforeApproved ? [string(before, "employeeId")] : []),
    ...(afterApproved ? [string(after, "employeeId")] : []),
  ].filter((value): value is string => value !== null));
  const startDate = earliest(
    beforeApproved ? string(before, "startDate") : null,
    afterApproved ? string(after, "startDate") : null,
  );
  const endDate = latest(
    beforeApproved ? string(before, "endDate") : null,
    afterApproved ? string(after, "endDate") : null,
  ) ?? startDate;
  if (startDate === null || endDate === null) return;
  const organization = firestore.collection("organizations").doc(event.params.organizationId);
  const jobs: Array<{ ref: DocumentReference; data: DocumentData }> = [];
  for (const employeeId of employeeIds) {
    const job = organization.collection("recalculationJobs").doc(jobId(event.id, employeeId));
    jobs.push({ ref: job, data: {
      type: "employee_date_range",
      source: "leave_change",
      sourceDocumentId: event.params.leaveId,
      employeeId,
      startDate,
      endDate,
      cursorDate: startDate,
      state: "pending",
      createdAt: Timestamp.now(),
      createdBy: "system",
    } });
  }
  await createJobsIfAbsent(jobs);
});

export const recalculateHolidayChange = onDocumentWritten({
  document: "organizations/{organizationId}/holidays/{holidayId}",
  region: "asia-south1",
  retry: true,
}, async (event) => {
  const before = event.data?.before;
  const after = event.data?.after;
  const beforeRelevant = before?.exists === true && before.get("nonWorking") !== false;
  const afterRelevant = after?.exists === true && after.get("nonWorking") !== false;
  if (!beforeRelevant && !afterRelevant) return;
  const beforeStart = beforeRelevant ? string(before, "startDate") ?? string(before, "date") : null;
  const afterStart = afterRelevant ? string(after, "startDate") ?? string(after, "date") : null;
  const beforeEnd = beforeRelevant ? string(before, "endDate") ?? string(before, "date") : null;
  const afterEnd = afterRelevant ? string(after, "endDate") ?? string(after, "date") : null;
  const startDate = earliest(beforeStart, afterStart);
  const endDate = latest(beforeEnd, afterEnd);
  if (startDate === null || endDate === null) return;
  const branchIds = new Set([
    ...(beforeRelevant ? [string(before, "branchId")] : []),
    ...(afterRelevant ? [string(after, "branchId")] : []),
  ]);
  if (branchIds.size === 0) branchIds.add(null);
  const organization = firestore.collection("organizations").doc(event.params.organizationId);
  const jobs: Array<{ ref: DocumentReference; data: DocumentData }> = [];
  for (const branchId of branchIds) {
    const suffix = branchId ?? "all";
    const job = organization.collection("recalculationJobs").doc(jobId(event.id, suffix));
    jobs.push({ ref: job, data: {
      type: "organization_date_range",
      source: "holiday_change",
      sourceDocumentId: event.params.holidayId,
      branchId,
      startDate,
      endDate,
      cursorEmployeeId: null,
      state: "pending",
      createdAt: Timestamp.now(),
      createdBy: "system",
    } });
  }
  await createJobsIfAbsent(jobs);
});
