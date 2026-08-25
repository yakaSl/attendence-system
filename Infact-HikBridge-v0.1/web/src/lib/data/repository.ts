import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase/firestore";

import {
  demoAttendance,
  demoDate,
  demoDepartments,
  demoDevices,
  demoEmployees,
  demoOrganization,
  demoShifts,
  demoUnmapped,
} from "./demo";
import { attendanceDisplayStatus } from "./attendance-status";
import type {
  AttendanceDay,
  AttendanceStatus,
  Branch,
  DashboardSnapshot,
  Department,
  Device,
  DeviceEnrollment,
  Employee,
  EmployeeDetail,
  Organization,
  ReportFilters,
  Shift,
  ShiftInference,
  TrendPoint,
  UnmappedIdentity,
} from "./types";

export interface AttendanceRepository {
  getOrganization(organizationId: string): Promise<Organization>;
  getDashboard(organizationId: string, date: string): Promise<DashboardSnapshot>;
  getEmployees(organizationId: string, date: string): Promise<Employee[]>;
  getEmployeeDetail(organizationId: string, employeeId: string, month: string): Promise<EmployeeDetail | null>;
  getAttendance(organizationId: string, filters: ReportFilters): Promise<AttendanceDay[]>;
  getBranches(organizationId: string): Promise<Branch[]>;
  getDepartments(organizationId: string): Promise<Department[]>;
  getShifts(organizationId: string): Promise<Shift[]>;
  getShiftInferences(organizationId: string): Promise<ShiftInference[]>;
  getDevices(organizationId: string): Promise<Device[]>;
  getDeviceEnrollments(organizationId: string): Promise<DeviceEnrollment[]>;
  getUnmappedIdentities(organizationId: string): Promise<UnmappedIdentity[]>;
}

function monthRange(month: string): { from: string; to: string } {
  const start = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(start.getTime())) throw new Error("Month must use YYYY-MM format");
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function isMissingPunch(day: AttendanceDay): boolean {
  return attendanceDisplayStatus(day) === "missing_punch";
}

function trend(days: AttendanceDay[], endDate: string): TrendPoint[] {
  const end = new Date(`${endDate}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - (6 - index));
    const key = date.toISOString().slice(0, 10);
    const matching = days.filter((day) => day.date === key);
    return {
      date: key,
      present: matching.filter((day) => day.status === "present").length,
      absent: matching.filter((day) => day.status === "absent").length,
      late: matching.filter((day) => day.lateMinutes > 0).length,
      leave: matching.filter((day) => day.status === "leave").length,
    };
  });
}

function dashboardSnapshot(employees: Employee[], attendance: AttendanceDay[], devices: Device[], unmapped: UnmappedIdentity[], date: string): DashboardSnapshot {
  const today = attendance.filter((day) => day.date === date);
  return {
    employeeCount: employees.filter((employee) => employee.active).length,
    presentToday: today.filter((day) => day.status === "present").length,
    absentToday: today.filter((day) => day.status === "absent").length,
    lateToday: today.filter((day) => day.lateMinutes > 0).length,
    leaveToday: today.filter((day) => day.status === "leave").length,
    totalLateMinutes: today.reduce((sum, day) => sum + day.lateMinutes, 0),
    totalOvertimeMinutes: today.reduce((sum, day) => sum + day.overtimeMinutes, 0),
    missingPunches: today.filter(isMissingPunch).length,
    devicesOffline: devices.filter((device) => device.connectionStatus === "offline").length,
    unmappedEvents: unmapped.reduce((sum, identity) => sum + identity.eventCount, 0),
    attendance: today,
    devices,
    trend: trend(attendance, date),
  };
}

function applyAttendanceFilters(days: AttendanceDay[], filters: ReportFilters): AttendanceDay[] {
  return days.filter((day) =>
    day.date >= filters.from &&
    day.date <= filters.to &&
    (filters.employeeId === undefined || filters.employeeId === "" || day.employeeId === filters.employeeId) &&
    (filters.departmentId === undefined || filters.departmentId === "" || day.departmentId === filters.departmentId) &&
    (filters.branchId === undefined || filters.branchId === "" || day.branchId === filters.branchId) &&
    (filters.shiftId === undefined || filters.shiftId === "" || day.shiftId === filters.shiftId) &&
    (filters.status === undefined ||
      (filters.status === "missing_punch" || filters.status === "checked_in" || filters.status === "unscheduled_punch" ?
        attendanceDisplayStatus(day) === filters.status : day.status === filters.status)),
  );
}

class DemoRepository implements AttendanceRepository {
  async getOrganization(): Promise<Organization> {
    return demoOrganization;
  }

  async getDashboard(_organizationId: string, date: string): Promise<DashboardSnapshot> {
    const effectiveDate = demoAttendance.some((day) => day.date === date) ? date : demoDate;
    return dashboardSnapshot(demoEmployees, demoAttendance, demoDevices, demoUnmapped, effectiveDate);
  }

  async getEmployees(): Promise<Employee[]> {
    return demoEmployees;
  }

  async getEmployeeDetail(_organizationId: string, employeeId: string, month: string): Promise<EmployeeDetail | null> {
    const employee = demoEmployees.find((candidate) => candidate.id === employeeId);
    if (employee === undefined) return null;
    const range = monthRange(month);
    return {
      employee,
      days: demoAttendance.filter((day) => day.employeeId === employeeId && day.date >= range.from && day.date <= range.to)
        .sort((left, right) => right.date.localeCompare(left.date)),
    };
  }

  async getAttendance(_organizationId: string, filters: ReportFilters): Promise<AttendanceDay[]> {
    return applyAttendanceFilters(demoAttendance, filters).sort((left, right) =>
      right.date.localeCompare(left.date) || left.employeeName.localeCompare(right.employeeName),
    );
  }

  async getBranches(): Promise<Branch[]> {
    return [...new Map(
      demoEmployees
        .filter((employee) => employee.branchId !== null)
        .map((employee) => [employee.branchId as string, employee.branchName]),
    )].map(([id, name]) => ({ id, name, timezone: demoOrganization.timezone, status: "active" as const }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getDepartments(): Promise<Department[]> {
    return demoDepartments;
  }

  async getShifts(): Promise<Shift[]> {
    return demoShifts;
  }

  async getShiftInferences(): Promise<ShiftInference[]> {
    return [];
  }

  async getDevices(): Promise<Device[]> {
    return demoDevices;
  }

  async getDeviceEnrollments(): Promise<DeviceEnrollment[]> {
    return [];
  }

  async getUnmappedIdentities(): Promise<UnmappedIdentity[]> {
    return demoUnmapped;
  }
}

function stringValue(data: DocumentData, field: string, fallback = ""): string {
  const value = data[field];
  return typeof value === "string" ? value : fallback;
}

function optionalString(data: DocumentData, field: string): string | null {
  const value = data[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(data: DocumentData, field: string): number {
  const value = data[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(data: DocumentData, field: string): string[] {
  const value = data[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function timestampString(value: unknown): string | null {
  return value instanceof Timestamp ? value.toDate().toISOString() : null;
}

export function effectiveDeviceConnectionStatus(
  enabled: boolean,
  storedStatus: unknown,
  lastSeenAt: string | null,
  nowMilliseconds = Date.now(),
): Device["connectionStatus"] {
  if (!enabled) return "disabled";
  if (lastSeenAt !== null && nowMilliseconds - new Date(lastSeenAt).getTime() > 6 * 60 * 1000) return "offline";
  const allowed: Device["connectionStatus"][] = ["online", "offline", "unknown"];
  return allowed.includes(storedStatus as Device["connectionStatus"]) ? storedStatus as Device["connectionStatus"] : "unknown";
}

function attendanceStatus(value: unknown): AttendanceStatus {
  const allowed: AttendanceStatus[] = ["present", "absent", "leave", "holiday", "rest_day", "no_shift"];
  return typeof value === "string" && allowed.includes(value as AttendanceStatus) ? value as AttendanceStatus : "no_shift";
}

interface RosterData {
  employees: Map<string, QueryDocumentSnapshot<DocumentData>>;
  departments: Map<string, string>;
  branches: Map<string, string>;
  shifts: Map<string, Shift>;
  assignments: QueryDocumentSnapshot<DocumentData>[];
}

class FirestoreRepository implements AttendanceRepository {
  constructor(private readonly db: Firestore) {}

  private organization(organizationId: string) {
    return doc(this.db, "organizations", organizationId);
  }

  async getOrganization(organizationId: string): Promise<Organization> {
    const snapshot = await getDoc(this.organization(organizationId));
    if (!snapshot.exists()) throw new Error("Organization was not found or is not accessible");
    return {
      id: snapshot.id,
      name: stringValue(snapshot.data(), "name", "Organization"),
      timezone: stringValue(snapshot.data(), "timezone", "UTC"),
      primaryBranchId: optionalString(snapshot.data(), "primaryBranchId"),
    };
  }

  private async roster(organizationId: string, date: string): Promise<RosterData> {
    const organization = this.organization(organizationId);
    const [employees, departments, branches, shifts, assignments] = await Promise.all([
      getDocs(query(collection(organization, "employees"), limit(1000))),
      getDocs(query(collection(organization, "departments"), limit(200))),
      getDocs(query(collection(organization, "branches"), limit(200))),
      getDocs(query(collection(organization, "shifts"), limit(200))),
      getDocs(query(
        collection(organization, "shiftAssignments"),
        where("effectiveFrom", "<=", date),
        orderBy("effectiveFrom", "desc"),
        limit(2000),
      )),
    ]);
    return {
      employees: new Map(employees.docs.map((snapshot) => [snapshot.id, snapshot])),
      departments: new Map(departments.docs.map((snapshot) => [snapshot.id, stringValue(snapshot.data(), "name", "Unassigned")])),
      branches: new Map(branches.docs.map((snapshot) => [snapshot.id, stringValue(snapshot.data(), "name", "Unassigned")])),
      shifts: new Map(shifts.docs.map((snapshot) => [snapshot.id, this.shift(snapshot)])),
      assignments: assignments.docs,
    };
  }

  private shift(snapshot: QueryDocumentSnapshot<DocumentData>): Shift {
    const data = snapshot.data();
    const overtime = typeof data.overtime === "object" && data.overtime !== null ? data.overtime as DocumentData : {};
    const earlyLeave = typeof data.earlyLeave === "object" && data.earlyLeave !== null ? data.earlyLeave as DocumentData : {};
    const workingDays = Array.isArray(data.workingDays) ? data.workingDays.filter((day: unknown): day is number => Number.isInteger(day)) : [];
    return {
      id: snapshot.id,
      name: stringValue(data, "name", snapshot.id),
      startTime: stringValue(data, "startTime"),
      endTime: stringValue(data, "endTime"),
      workingDays,
      gracePeriodMinutes: numberValue(data, "gracePeriodMinutes"),
      lateCalculationMode: data.lateCalculationMode === "from_shift_start" ? "from_shift_start" : "after_grace",
      breakMinutes: numberValue(data, "breakMinutes"),
      punchMode: data.punchMode === "explicit_status" ? "explicit_status" : "first_last",
      earlyLeaveGraceMinutes: numberValue(earlyLeave, "graceMinutes"),
      overtimeEnabled: overtime.enabled === true,
      overtimeStartDelayMinutes: numberValue(overtime, "startDelayMinutes"),
      overtimeMinimumMinutes: numberValue(overtime, "minimumMinutes"),
      overtimeRoundingMinutes: numberValue(overtime, "roundingMinutes"),
      overtimeRoundingMode: (["none", "floor", "nearest", "ceil"] as unknown[]).includes(overtime.roundingMode) ?
        overtime.roundingMode as Shift["overtimeRoundingMode"] : "none",
      active: data.active !== false,
    };
  }

  private assignment(roster: RosterData, employeeId: string, date: string): Shift | null {
    const match = roster.assignments.find((candidate) => {
      if (candidate.get("employeeId") !== employeeId) return false;
      const effectiveTo = candidate.get("effectiveTo");
      return effectiveTo === null || effectiveTo === undefined || (typeof effectiveTo === "string" && effectiveTo >= date);
    });
    const shiftId = match?.get("shiftId");
    return typeof shiftId === "string" ? roster.shifts.get(shiftId) ?? null : null;
  }

  private attendanceDay(snapshot: QueryDocumentSnapshot<DocumentData>, roster: RosterData): AttendanceDay {
    const data = snapshot.data();
    const employeeId = stringValue(data, "employeeId");
    const employee = roster.employees.get(employeeId)?.data() ?? {};
    const departmentId = stringValue(employee, "departmentId") || null;
    const branchId = stringValue(employee, "branchId") || null;
    return {
      id: snapshot.id,
      employeeId,
      employeeCode: stringValue(employee, "employeeCode", employeeId),
      employeeName: stringValue(employee, "name", employeeId),
      departmentId,
      departmentName: departmentId === null ? "Unassigned" : roster.departments.get(departmentId) ?? "Unassigned",
      branchId,
      branchName: branchId === null ? "Unassigned" : roster.branches.get(branchId) ?? "Unassigned",
      shiftId: stringValue(data, "shiftId") || null,
      shiftName: stringValue(data, "shiftName", "No shift"),
      date: stringValue(data, "date"),
      scheduledIn: stringValue(data, "scheduledIn") || null,
      scheduledOut: stringValue(data, "scheduledOut") || null,
      scheduledOutAt: stringValue(data, "scheduledOutAt") || timestampString(data.scheduledOutTimestamp),
      firstIn: stringValue(data, "firstIn") || null,
      lastOut: stringValue(data, "lastOut") || null,
      workedMinutes: numberValue(data, "workedMinutes"),
      lateMinutes: numberValue(data, "lateMinutes"),
      earlyLeaveMinutes: numberValue(data, "earlyLeaveMinutes"),
      overtimeMinutes: numberValue(data, "overtimeMinutes"),
      status: attendanceStatus(data.status),
      exceptions: stringArray(data, "exceptions"),
      hasManualAdjustment: data.hasManualAdjustment === true,
      shiftSource: (["assigned", "automatic", "confirmed"] as unknown[]).includes(data.shiftSource) ?
        data.shiftSource as AttendanceDay["shiftSource"] : null,
      shiftInferenceConfidence: (["high", "medium", "low", "none"] as unknown[]).includes(data.shiftInferenceConfidence) ?
        data.shiftInferenceConfidence as AttendanceDay["shiftInferenceConfidence"] : null,
    };
  }

  private async attendanceRange(organizationId: string, from: string, to: string, roster: RosterData): Promise<AttendanceDay[]> {
    const organization = this.organization(organizationId);
    const snapshots = await getDocs(query(
      collection(organization, "attendanceDays"),
      where("date", ">=", from),
      where("date", "<=", to),
      orderBy("date", "desc"),
      limit(5000),
    ));
    return snapshots.docs.map((snapshot) => this.attendanceDay(snapshot, roster));
  }

  async getDashboard(organizationId: string, date: string): Promise<DashboardSnapshot> {
    const roster = await this.roster(organizationId, date);
    const sevenDaysAgo = new Date(`${date}T00:00:00Z`);
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);
    const [attendance, devices, unmapped] = await Promise.all([
      this.attendanceRange(organizationId, sevenDaysAgo.toISOString().slice(0, 10), date, roster),
      this.getDevices(organizationId),
      this.getUnmappedIdentities(organizationId),
    ]);
    return dashboardSnapshot(await this.employeeRows(roster, attendance, date), attendance, devices, unmapped, date);
  }

  private async employeeRows(roster: RosterData, monthDays: AttendanceDay[], date: string): Promise<Employee[]> {
    return [...roster.employees].map(([id, snapshot]): Employee => {
      const data = snapshot.data();
      const departmentId = stringValue(data, "departmentId") || null;
      const branchId = stringValue(data, "branchId") || null;
      const shift = this.assignment(roster, id, date);
      const today = monthDays.find((day) => day.employeeId === id && day.date === date);
      const employeeDays = monthDays.filter((day) => day.employeeId === id);
      return {
        id,
        employeeCode: stringValue(data, "employeeCode", id),
        name: stringValue(data, "name", id),
        departmentId,
        departmentName: departmentId === null ? "Unassigned" : roster.departments.get(departmentId) ?? "Unassigned",
        branchId,
        branchName: branchId === null ? "Unassigned" : roster.branches.get(branchId) ?? "Unassigned",
        shiftId: shift?.id ?? today?.shiftId ?? null,
        shiftName: shift?.name ?? today?.shiftName ?? "No shift",
        todayStatus: today === undefined ? null : attendanceDisplayStatus(today),
        lastPunch: today?.lastOut ?? today?.firstIn ?? null,
        lateMinutesThisMonth: employeeDays.reduce((sum, day) => sum + day.lateMinutes, 0),
        overtimeMinutesThisMonth: employeeDays.reduce((sum, day) => sum + day.overtimeMinutes, 0),
        active: data.active !== false,
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
  }

  async getEmployees(organizationId: string, date: string): Promise<Employee[]> {
    const roster = await this.roster(organizationId, date);
    const range = monthRange(date.slice(0, 7));
    const attendance = await this.attendanceRange(organizationId, range.from, range.to, roster);
    return this.employeeRows(roster, attendance, date);
  }

  async getEmployeeDetail(organizationId: string, employeeId: string, month: string): Promise<EmployeeDetail | null> {
    const range = monthRange(month);
    const roster = await this.roster(organizationId, range.to);
    if (!roster.employees.has(employeeId)) return null;
    const days = await this.attendanceRange(organizationId, range.from, range.to, roster);
    const employee = (await this.employeeRows(roster, days, range.to)).find((candidate) => candidate.id === employeeId);
    return employee === undefined ? null : {
      employee,
      days: days.filter((day) => day.employeeId === employeeId),
    };
  }

  async getAttendance(organizationId: string, filters: ReportFilters): Promise<AttendanceDay[]> {
    const roster = await this.roster(organizationId, filters.to);
    return applyAttendanceFilters(await this.attendanceRange(organizationId, filters.from, filters.to, roster), filters);
  }

  async getBranches(organizationId: string): Promise<Branch[]> {
    const snapshots = await getDocs(query(collection(this.organization(organizationId), "branches"), limit(200)));
    return snapshots.docs.map((snapshot): Branch => {
      const data = snapshot.data();
      return {
        id: snapshot.id,
        name: stringValue(data, "name", snapshot.id),
        timezone: stringValue(data, "timezone", "UTC"),
        status: data.status === "inactive" ? "inactive" : "active",
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
  }

  async getDeviceEnrollments(organizationId: string): Promise<DeviceEnrollment[]> {
    const snapshots = await getDocs(query(collection(this.organization(organizationId), "deviceEnrollments"), limit(2000)));
    return snapshots.docs.map((snapshot): DeviceEnrollment => {
      const data = snapshot.data();
      const states: DeviceEnrollment["state"][] = ["user_pending", "user_synced", "queued", "capturing", "enrolled", "failed"];
      const storedState = stringValue(data, "state") as DeviceEnrollment["state"];
      return {
        id: snapshot.id,
        deviceId: stringValue(data, "deviceId"),
        employeeId: stringValue(data, "employeeId"),
        employeeNo: stringValue(data, "employeeNo"),
        state: states.includes(storedState) ? storedState : "failed",
        fingerPrintId: typeof data.fingerPrintId === "number" ? data.fingerPrintId : null,
        quality: typeof data.quality === "number" ? data.quality : null,
        lastError: typeof data.lastError === "string" ? data.lastError : null,
        updatedAt: timestampString(data.updatedAt),
      };
    });
  }

  async getDepartments(organizationId: string): Promise<Department[]> {
    const snapshots = await getDocs(query(collection(this.organization(organizationId), "departments"), limit(200)));
    return snapshots.docs.map((snapshot) => ({ id: snapshot.id, name: stringValue(snapshot.data(), "name", snapshot.id) }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getShifts(organizationId: string): Promise<Shift[]> {
    const snapshots = await getDocs(query(collection(this.organization(organizationId), "shifts"), limit(200)));
    return snapshots.docs.map((snapshot) => this.shift(snapshot)).sort((left, right) => left.name.localeCompare(right.name));
  }

  async getShiftInferences(organizationId: string): Promise<ShiftInference[]> {
    const snapshots = await getDocs(query(
      collection(this.organization(organizationId), "shiftInferences"),
      where("state", "==", "review_required"),
      limit(200),
    ));
    return snapshots.docs.map((snapshot): ShiftInference => {
      const data = snapshot.data();
      const candidates = Array.isArray(data.candidates) ? data.candidates.flatMap((value: unknown) => {
        if (typeof value !== "object" || value === null) return [];
        const candidate = value as DocumentData;
        const shiftId = stringValue(candidate, "shiftId");
        if (shiftId === "") return [];
        return [{
          shiftId,
          shiftName: stringValue(candidate, "shiftName", shiftId),
          startTime: stringValue(candidate, "startTime"),
          punchAt: stringValue(candidate, "punchAt"),
          distanceMinutes: numberValue(candidate, "distanceMinutes"),
        }];
      }) : [];
      return {
        id: snapshot.id,
        employeeId: stringValue(data, "employeeId"),
        employeeCode: stringValue(data, "employeeCode"),
        employeeName: stringValue(data, "employeeName", "Unknown employee"),
        date: stringValue(data, "date"),
        confidence: data.confidence === "medium" ? "medium" : "low",
        suggestedShiftId: optionalString(data, "suggestedShiftId"),
        firstPunchAt: optionalString(data, "firstPunchAt"),
        explanation: stringValue(data, "explanation", "Punch time did not clearly match one shift."),
        candidates,
      };
    }).sort((left, right) => right.date.localeCompare(left.date) || left.employeeName.localeCompare(right.employeeName));
  }

  async getDevices(organizationId: string): Promise<Device[]> {
    const organization = this.organization(organizationId);
    const [devices, branches] = await Promise.all([
      getDocs(query(collection(organization, "devices"), limit(200))),
      getDocs(query(collection(organization, "branches"), limit(200))),
    ]);
    const branchNames = new Map(branches.docs.map((snapshot) => [snapshot.id, stringValue(snapshot.data(), "name", snapshot.id)]));
    return devices.docs.map((snapshot): Device => {
      const data = snapshot.data();
      const lastSeenAt = timestampString(data.lastSeen);
      const branchId = stringValue(data, "branchId");
      return {
        id: snapshot.id,
        branchId,
        name: stringValue(data, "name", snapshot.id),
        model: stringValue(data, "deviceModel", "Hikvision terminal"),
        branchName: branchNames.get(branchId) ?? "Unassigned",
        connectionStatus: effectiveDeviceConnectionStatus(data.enabled !== false, data.connectionStatus, lastSeenAt),
        lastSeenAt,
        lastEventAt: timestampString(data.lastEventAt),
        bridgeVersion: stringValue(data, "bridgeVersion") || null,
        firmwareVersion: stringValue(data, "firmwareVersion") || null,
        pendingLocalEvents: typeof data.pendingLocalEvents === "number" ? data.pendingLocalEvents : null,
      };
    });
  }

  async getUnmappedIdentities(organizationId: string): Promise<UnmappedIdentity[]> {
    const organization = this.organization(organizationId);
    const [identities, devices] = await Promise.all([
      getDocs(query(
        collection(organization, "unmappedIdentities"),
        where("state", "==", "unmapped"),
        orderBy("lastSeenAt", "desc"),
        limit(100),
      )),
      getDocs(query(collection(organization, "devices"), limit(200))),
    ]);
    const deviceNames = new Map(devices.docs.map((snapshot) => [snapshot.id, stringValue(snapshot.data(), "name", snapshot.id)]));
    return identities.docs.map((snapshot) => {
      const data = snapshot.data();
      const deviceId = stringValue(data, "deviceId");
      return {
        id: snapshot.id,
        deviceId,
        deviceName: deviceNames.get(deviceId) ?? deviceId,
        employeeNo: stringValue(data, "employeeNo"),
        deviceEmployeeName: stringValue(data, "deviceEmployeeName", "Unknown user"),
        eventCount: numberValue(data, "eventCount"),
        firstSeenAt: timestampString(data.firstSeenAt),
        lastSeenAt: timestampString(data.lastSeenAt),
      };
    });
  }
}

export const demoRepository: AttendanceRepository = new DemoRepository();

export function firestoreRepository(db: Firestore): AttendanceRepository {
  return new FirestoreRepository(db);
}
