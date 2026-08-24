import { Temporal } from "@js-temporal/polyfill";
import { FieldPath, FieldValue, Timestamp, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";

import { firestore } from "../firebase.js";
import { candidateAttendanceDates, recalculateAttendance } from "./recalculation.js";

const PAGE_SIZE = 200;

async function processIdentityMappingJob(job: QueryDocumentSnapshot): Promise<void> {
  const organization = job.ref.parent.parent;
  if (organization === null) throw new Error(`Job ${job.ref.path} is not nested under an organization`);
  const deviceId = job.get("deviceId");
  const employeeNo = job.get("employeeNo");
  const employeeId = job.get("employeeId");
  if (typeof deviceId !== "string" || typeof employeeNo !== "string" || typeof employeeId !== "string") {
    throw new Error(`Job ${job.ref.path} has invalid identity fields`);
  }
  const organizationSnapshot = await organization.get();
  const timezone = organizationSnapshot.get("timezone");
  if (typeof timezone !== "string") throw new Error(`Organization ${organization.id} has no timezone`);

  let query = organization.collection("attendanceEvents")
    .where("deviceId", "==", deviceId)
    .where("employeeNo", "==", employeeNo)
    .orderBy("eventTime", "asc")
    .orderBy(FieldPath.documentId(), "asc")
    .limit(PAGE_SIZE);
  const cursorTime = job.get("cursorEventTime");
  const cursorId = job.get("cursorEventId");
  if (cursorTime instanceof Timestamp && typeof cursorId === "string") {
    query = query.startAfter(cursorTime, cursorId);
  }
  const events = await query.get();
  const dates = new Set<string>();
  for (const event of events.docs) {
    const eventTime = event.get("eventTime");
    if (eventTime instanceof Timestamp) {
      for (const date of candidateAttendanceDates(eventTime.toDate(), timezone)) dates.add(date);
    }
  }
  for (const date of [...dates].sort()) {
    await recalculateAttendance(firestore, organization.id, employeeId, date);
  }

  const last = events.docs.at(-1);
  if (events.size < PAGE_SIZE || last === undefined) {
    await job.ref.update({
      state: "completed",
      completedAt: Timestamp.now(),
      processedEvents: FieldValue.increment(events.size),
      processedDates: FieldValue.increment(dates.size),
    });
  } else {
    await job.ref.update({
      state: "pending",
      cursorEventTime: last.get("eventTime"),
      cursorEventId: last.id,
      processedEvents: FieldValue.increment(events.size),
      processedDates: FieldValue.increment(dates.size),
      updatedAt: Timestamp.now(),
    });
  }
}

async function processEmployeeDateRangeJob(job: QueryDocumentSnapshot): Promise<void> {
  const organization = job.ref.parent.parent;
  if (organization === null) throw new Error(`Job ${job.ref.path} is not nested under an organization`);
  const employeeId = job.get("employeeId");
  const startDate = job.get("cursorDate") ?? job.get("startDate");
  const endDate = job.get("endDate");
  if (typeof employeeId !== "string" || typeof startDate !== "string" || typeof endDate !== "string") {
    throw new Error(`Job ${job.ref.path} has invalid employee date range fields`);
  }
  let cursor = Temporal.PlainDate.from(startDate);
  const end = Temporal.PlainDate.from(endDate);
  let processed = 0;
  while (Temporal.PlainDate.compare(cursor, end) <= 0 && processed < 31) {
    await recalculateAttendance(firestore, organization.id, employeeId, cursor.toString());
    cursor = cursor.add({ days: 1 });
    processed++;
  }
  const completed = Temporal.PlainDate.compare(cursor, end) > 0;
  await job.ref.update({
    state: completed ? "completed" : "pending",
    cursorDate: cursor.toString(),
    processedDates: FieldValue.increment(processed),
    updatedAt: Timestamp.now(),
    ...(completed ? { completedAt: Timestamp.now() } : {}),
  });
}

async function processShiftPolicyJob(job: QueryDocumentSnapshot): Promise<void> {
  const organization = job.ref.parent.parent;
  if (organization === null) throw new Error(`Job ${job.ref.path} is not nested under an organization`);
  const shiftId = job.get("shiftId");
  const fromDate = job.get("fromDate");
  const toDate = job.get("toDate");
  if (typeof shiftId !== "string" || typeof fromDate !== "string" || typeof toDate !== "string") {
    throw new Error(`Job ${job.ref.path} has invalid shift policy fields`);
  }
  let query = organization.collection("shiftAssignments")
    .where("shiftId", "==", shiftId)
    .orderBy(FieldPath.documentId(), "asc")
    .limit(100);
  const cursorAssignmentId = job.get("cursorAssignmentId");
  if (typeof cursorAssignmentId === "string" && cursorAssignmentId.length > 0) {
    query = query.startAfter(cursorAssignmentId);
  }
  const assignments = await query.get();
  const batch = firestore.batch();
  for (const assignment of assignments.docs) {
    const employeeId = assignment.get("employeeId");
    const effectiveFrom = assignment.get("effectiveFrom");
    const effectiveTo = assignment.get("effectiveTo");
    if (typeof employeeId !== "string" || typeof effectiveFrom !== "string") continue;
    const startDate = effectiveFrom > fromDate ? effectiveFrom : fromDate;
    const assignmentEnd = typeof effectiveTo === "string" ? effectiveTo : toDate;
    const endDate = assignmentEnd < toDate ? assignmentEnd : toDate;
    if (startDate > endDate) continue;
    const child = organization.collection("recalculationJobs").doc(`${job.id}_${assignment.id}`);
    batch.set(child, {
      type: "employee_date_range",
      parentJobId: job.id,
      employeeId,
      startDate,
      endDate,
      cursorDate: startDate,
      state: "pending",
      createdAt: Timestamp.now(),
      createdBy: "system",
    }, { merge: false });
  }
  const last = assignments.docs.at(-1);
  batch.update(job.ref, assignments.size < 100 || last === undefined ? {
    state: "completed",
    processedAssignments: FieldValue.increment(assignments.size),
    completedAt: Timestamp.now(),
  } : {
    state: "pending",
    cursorAssignmentId: last.id,
    processedAssignments: FieldValue.increment(assignments.size),
    updatedAt: Timestamp.now(),
  });
  await batch.commit();
}

async function processOrganizationDateRangeJob(job: QueryDocumentSnapshot): Promise<void> {
  const organization = job.ref.parent.parent;
  if (organization === null) throw new Error(`Job ${job.ref.path} is not nested under an organization`);
  const startDate = job.get("startDate");
  const endDate = job.get("endDate");
  const branchId = job.get("branchId");
  if (typeof startDate !== "string" || typeof endDate !== "string" || (branchId !== null && typeof branchId !== "string")) {
    throw new Error(`Job ${job.ref.path} has invalid organization date range fields`);
  }
  let query = organization.collection("employees").orderBy(FieldPath.documentId(), "asc").limit(100);
  if (typeof branchId === "string") query = query.where("branchId", "==", branchId);
  const cursorEmployeeId = job.get("cursorEmployeeId");
  if (typeof cursorEmployeeId === "string" && cursorEmployeeId.length > 0) query = query.startAfter(cursorEmployeeId);
  const employees = await query.get();
  const batch = firestore.batch();
  for (const employee of employees.docs) {
    const child = organization.collection("recalculationJobs").doc(`${job.id}_${employee.id}`);
    batch.set(child, {
      type: "employee_date_range",
      parentJobId: job.id,
      employeeId: employee.id,
      startDate,
      endDate,
      cursorDate: startDate,
      state: "pending",
      createdAt: Timestamp.now(),
      createdBy: "system",
    }, { merge: false });
  }
  const last = employees.docs.at(-1);
  batch.update(job.ref, employees.size < 100 || last === undefined ? {
    state: "completed",
    processedEmployees: FieldValue.increment(employees.size),
    completedAt: Timestamp.now(),
  } : {
    state: "pending",
    cursorEmployeeId: last.id,
    processedEmployees: FieldValue.increment(employees.size),
    updatedAt: Timestamp.now(),
  });
  await batch.commit();
}

export const processAttendanceRecalculationJobs = onSchedule({
  schedule: "every 5 minutes",
  region: "asia-south1",
  timeoutSeconds: 540,
  memory: "512MiB",
  maxInstances: 1,
  retryCount: 3,
}, async () => {
  const jobs = await firestore.collectionGroup("recalculationJobs")
    .where("state", "==", "pending")
    .limit(5)
    .get();
  for (const job of jobs.docs) {
    try {
      switch (job.get("type")) {
        case "identity_mapping":
          await processIdentityMappingJob(job);
          break;
        case "employee_date_range":
          await processEmployeeDateRangeJob(job);
          break;
        case "shift_policy":
          await processShiftPolicyJob(job);
          break;
        case "organization_date_range":
          await processOrganizationDateRangeJob(job);
          break;
        default:
          await job.ref.update({ state: "failed", errorCode: "unsupported_job_type", failedAt: Timestamp.now() });
      }
    } catch (error) {
      logger.error("attendance_recalculation_job_failed", {
        jobPath: job.ref.path,
        type: job.get("type"),
        error,
      });
      const attempts = typeof job.get("attempts") === "number" ? job.get("attempts") as number : 0;
      await job.ref.update({
        attempts: attempts + 1,
        lastAttemptAt: Timestamp.now(),
        errorCode: "processing_failed",
        ...(attempts >= 4 ? { state: "failed", failedAt: Timestamp.now() } : {}),
      });
    }
  }
});
