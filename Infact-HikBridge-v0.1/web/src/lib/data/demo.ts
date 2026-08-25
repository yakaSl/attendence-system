import type {
  AttendanceDay,
  Department,
  Device,
  Employee,
  Organization,
  Shift,
  UnmappedIdentity,
} from "./types";
import { attendanceDisplayStatus } from "./attendance-status";

export const demoDate = "2026-08-23";

export const demoOrganization: Organization = {
  id: "demo-organization",
  name: "Infact Solutions",
  timezone: "Asia/Colombo",
  primaryBranchId: "colombo",
};

export const demoDepartments: Department[] = [
  { id: "sales", name: "Sales" },
  { id: "operations", name: "Operations" },
  { id: "finance", name: "Finance" },
  { id: "engineering", name: "Engineering" },
];

export const demoShifts: Shift[] = [
  {
    id: "NORMAL",
    name: "Normal Shift",
    startTime: "08:30",
    endTime: "17:30",
    workingDays: [1, 2, 3, 4, 5],
    gracePeriodMinutes: 10,
    lateCalculationMode: "after_grace",
    breakMinutes: 60,
    punchMode: "first_last",
    earlyLeaveGraceMinutes: 5,
    overtimeEnabled: true,
    overtimeStartDelayMinutes: 15,
    overtimeMinimumMinutes: 30,
    overtimeRoundingMinutes: 15,
    overtimeRoundingMode: "floor",
    active: true,
  },
  {
    id: "NIGHT",
    name: "Night Operations",
    startTime: "22:00",
    endTime: "06:00",
    workingDays: [1, 2, 3, 4, 5, 6],
    gracePeriodMinutes: 5,
    lateCalculationMode: "from_shift_start",
    breakMinutes: 30,
    punchMode: "explicit_status",
    earlyLeaveGraceMinutes: 5,
    overtimeEnabled: true,
    overtimeStartDelayMinutes: 15,
    overtimeMinimumMinutes: 30,
    overtimeRoundingMinutes: 15,
    overtimeRoundingMode: "floor",
    active: true,
  },
  {
    id: "HALF_DAY",
    name: "Saturday Half Day",
    startTime: "08:30",
    endTime: "13:00",
    workingDays: [6],
    gracePeriodMinutes: 10,
    lateCalculationMode: "after_grace",
    breakMinutes: 0,
    punchMode: "first_last",
    earlyLeaveGraceMinutes: 0,
    overtimeEnabled: false,
    overtimeStartDelayMinutes: 0,
    overtimeMinimumMinutes: 0,
    overtimeRoundingMinutes: 1,
    overtimeRoundingMode: "none",
    active: true,
  },
];

const baseEmployees: Omit<Employee, "todayStatus" | "lastPunch" | "lateMinutesThisMonth" | "overtimeMinutesThisMonth">[] = [
  { id: "EMP0017", employeeCode: "EMP0017", name: "Kasun Perera", departmentId: "sales", departmentName: "Sales", branchId: "colombo", branchName: "Colombo HQ", shiftId: "NORMAL", shiftName: "Normal Shift", active: true },
  { id: "EMP0021", employeeCode: "EMP0021", name: "Nimali Silva", departmentId: "finance", departmentName: "Finance", branchId: "colombo", branchName: "Colombo HQ", shiftId: "NORMAL", shiftName: "Normal Shift", active: true },
  { id: "EMP0034", employeeCode: "EMP0034", name: "Dinesh Fernando", departmentId: "operations", departmentName: "Operations", branchId: "colombo", branchName: "Colombo HQ", shiftId: "NIGHT", shiftName: "Night Operations", active: true },
  { id: "EMP0042", employeeCode: "EMP0042", name: "Tharushi Jayasinghe", departmentId: "engineering", departmentName: "Engineering", branchId: "kandy", branchName: "Kandy", shiftId: "NORMAL", shiftName: "Normal Shift", active: true },
  { id: "EMP0048", employeeCode: "EMP0048", name: "Ashan Rodrigo", departmentId: "operations", departmentName: "Operations", branchId: "colombo", branchName: "Colombo HQ", shiftId: "NORMAL", shiftName: "Normal Shift", active: true },
  { id: "EMP0053", employeeCode: "EMP0053", name: "Sachini Gamage", departmentId: "sales", departmentName: "Sales", branchId: "kandy", branchName: "Kandy", shiftId: "NORMAL", shiftName: "Normal Shift", active: true },
  { id: "EMP0060", employeeCode: "EMP0060", name: "Ravindu Senanayake", departmentId: "engineering", departmentName: "Engineering", branchId: "colombo", branchName: "Colombo HQ", shiftId: "NORMAL", shiftName: "Normal Shift", active: true },
  { id: "EMP0066", employeeCode: "EMP0066", name: "Fathima Niyas", departmentId: "finance", departmentName: "Finance", branchId: "colombo", branchName: "Colombo HQ", shiftId: "NORMAL", shiftName: "Normal Shift", active: true },
];

const todayAttendance: AttendanceDay[] = [
  { id: `EMP0017_${demoDate}`, employeeId: "EMP0017", employeeCode: "EMP0017", employeeName: "Kasun Perera", departmentId: "sales", departmentName: "Sales", branchId: "colombo", branchName: "Colombo HQ", shiftId: "NORMAL", shiftName: "Normal Shift", date: demoDate, scheduledIn: "08:30", scheduledOut: "17:30", firstIn: "08:47", lastOut: "18:22", workedMinutes: 515, lateMinutes: 7, earlyLeaveMinutes: 0, overtimeMinutes: 30, status: "present", exceptions: ["late_arrival"], hasManualAdjustment: false },
  { id: `EMP0021_${demoDate}`, employeeId: "EMP0021", employeeCode: "EMP0021", employeeName: "Nimali Silva", departmentId: "finance", departmentName: "Finance", branchId: "colombo", branchName: "Colombo HQ", shiftId: "NORMAL", shiftName: "Normal Shift", date: demoDate, scheduledIn: "08:30", scheduledOut: "17:30", firstIn: "08:25", lastOut: "17:35", workedMinutes: 490, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, status: "present", exceptions: ["early_arrival"], hasManualAdjustment: false },
  { id: `EMP0034_${demoDate}`, employeeId: "EMP0034", employeeCode: "EMP0034", employeeName: "Dinesh Fernando", departmentId: "operations", departmentName: "Operations", branchId: "colombo", branchName: "Colombo HQ", shiftId: "NIGHT", shiftName: "Night Operations", date: demoDate, scheduledIn: "22:00", scheduledOut: "06:00", firstIn: "21:56", lastOut: null, workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, status: "present", exceptions: ["missing_check_out", "early_arrival"], hasManualAdjustment: false },
  { id: `EMP0042_${demoDate}`, employeeId: "EMP0042", employeeCode: "EMP0042", employeeName: "Tharushi Jayasinghe", departmentId: "engineering", departmentName: "Engineering", branchId: "kandy", branchName: "Kandy", shiftId: "NORMAL", shiftName: "Normal Shift", date: demoDate, scheduledIn: "08:30", scheduledOut: "17:30", firstIn: null, lastOut: null, workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, status: "leave", exceptions: [], hasManualAdjustment: false },
  { id: `EMP0048_${demoDate}`, employeeId: "EMP0048", employeeCode: "EMP0048", employeeName: "Ashan Rodrigo", departmentId: "operations", departmentName: "Operations", branchId: "colombo", branchName: "Colombo HQ", shiftId: "NORMAL", shiftName: "Normal Shift", date: demoDate, scheduledIn: "08:30", scheduledOut: "17:30", firstIn: null, lastOut: null, workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, status: "absent", exceptions: [], hasManualAdjustment: false },
  { id: `EMP0053_${demoDate}`, employeeId: "EMP0053", employeeCode: "EMP0053", employeeName: "Sachini Gamage", departmentId: "sales", departmentName: "Sales", branchId: "kandy", branchName: "Kandy", shiftId: "NORMAL", shiftName: "Normal Shift", date: demoDate, scheduledIn: "08:30", scheduledOut: "17:30", firstIn: "08:34", lastOut: "17:12", workedMinutes: 458, lateMinutes: 0, earlyLeaveMinutes: 13, overtimeMinutes: 0, status: "present", exceptions: ["early_leave"], hasManualAdjustment: false },
  { id: `EMP0060_${demoDate}`, employeeId: "EMP0060", employeeCode: "EMP0060", employeeName: "Ravindu Senanayake", departmentId: "engineering", departmentName: "Engineering", branchId: "colombo", branchName: "Colombo HQ", shiftId: "NORMAL", shiftName: "Normal Shift", date: demoDate, scheduledIn: "08:30", scheduledOut: "17:30", firstIn: "08:28", lastOut: "17:41", workedMinutes: 493, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, status: "present", exceptions: [], hasManualAdjustment: true },
  { id: `EMP0066_${demoDate}`, employeeId: "EMP0066", employeeCode: "EMP0066", employeeName: "Fathima Niyas", departmentId: "finance", departmentName: "Finance", branchId: "colombo", branchName: "Colombo HQ", shiftId: "NORMAL", shiftName: "Normal Shift", date: demoDate, scheduledIn: "08:30", scheduledOut: "17:30", firstIn: "08:52", lastOut: "17:38", workedMinutes: 466, lateMinutes: 12, earlyLeaveMinutes: 0, overtimeMinutes: 0, status: "present", exceptions: ["late_arrival"], hasManualAdjustment: false },
];

function previousDate(dayOffset: number): string {
  const date = new Date(`${demoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - dayOffset);
  return date.toISOString().slice(0, 10);
}

const historicalAttendance: AttendanceDay[] = baseEmployees.flatMap((employee, employeeIndex) =>
  Array.from({ length: 22 }, (_, index): AttendanceDay => {
    const date = previousDate(index + 1);
    const leave = (index + employeeIndex) % 19 === 0;
    const absent = !leave && (index * 3 + employeeIndex) % 23 === 0;
    const late = !leave && !absent && (index + employeeIndex) % 5 === 0 ? 8 + employeeIndex : 0;
    const overtime = !leave && !absent && (index + employeeIndex) % 4 === 0 ? 30 : 0;
    return {
      id: `${employee.id}_${date}`,
      employeeId: employee.id,
      employeeCode: employee.employeeCode,
      employeeName: employee.name,
      departmentId: employee.departmentId,
      departmentName: employee.departmentName,
      branchId: employee.branchId,
      branchName: employee.branchName,
      shiftId: employee.shiftId,
      shiftName: employee.shiftName,
      date,
      scheduledIn: employee.shiftId === "NIGHT" ? "22:00" : "08:30",
      scheduledOut: employee.shiftId === "NIGHT" ? "06:00" : "17:30",
      firstIn: leave || absent ? null : late > 0 ? "08:48" : "08:27",
      lastOut: leave || absent ? null : overtime > 0 ? "18:20" : "17:34",
      workedMinutes: leave || absent ? 0 : 487 + overtime,
      lateMinutes: late,
      earlyLeaveMinutes: 0,
      overtimeMinutes: overtime,
      status: leave ? "leave" : absent ? "absent" : "present",
      exceptions: late > 0 ? ["late_arrival"] : [],
      hasManualAdjustment: (index + employeeIndex) % 31 === 0,
    };
  }),
);

export const demoAttendance: AttendanceDay[] = [...todayAttendance, ...historicalAttendance];

export const demoEmployees: Employee[] = baseEmployees.map((employee) => {
  const day = todayAttendance.find((candidate) => candidate.employeeId === employee.id);
  const month = demoAttendance.filter((candidate) => candidate.employeeId === employee.id);
  return {
    ...employee,
    todayStatus: day === undefined ? null : attendanceDisplayStatus(day),
    lastPunch: day?.lastOut ?? day?.firstIn ?? null,
    lateMinutesThisMonth: month.reduce((sum, candidate) => sum + candidate.lateMinutes, 0),
    overtimeMinutesThisMonth: month.reduce((sum, candidate) => sum + candidate.overtimeMinutes, 0),
  };
});

export const demoDevices: Device[] = [
  { id: "office-main-01", branchId: "colombo-hq", name: "Main Entrance", model: "DS-K1A8503EF", branchName: "Colombo HQ", connectionStatus: "online", lastSeenAt: "2026-08-23T16:59:40Z", lastEventAt: "2026-08-23T16:57:12Z", bridgeVersion: "0.1.0", firmwareVersion: "V3.5.0", pendingLocalEvents: 0 },
  { id: "office-back-01", branchId: "colombo-hq", name: "Staff Entrance", model: "DS-K1A8503EF", branchName: "Colombo HQ", connectionStatus: "offline", lastSeenAt: "2026-08-23T15:44:10Z", lastEventAt: "2026-08-23T15:40:02Z", bridgeVersion: "0.1.0", firmwareVersion: "V3.5.0", pendingLocalEvents: null },
  { id: "kandy-main-01", branchId: "kandy", name: "Kandy Reception", model: "DS-K1A8503EF", branchName: "Kandy", connectionStatus: "online", lastSeenAt: "2026-08-23T16:59:52Z", lastEventAt: "2026-08-23T16:54:43Z", bridgeVersion: "0.1.0", firmwareVersion: "V3.5.0", pendingLocalEvents: 2 },
];

export const demoUnmapped: UnmappedIdentity[] = [
  { id: "identity-17", deviceId: "office-main-01", deviceName: "Main Entrance", employeeNo: "17", deviceEmployeeName: "Kasun", eventCount: 2, firstSeenAt: "2026-08-22T03:18:00Z", lastSeenAt: "2026-08-23T03:17:00Z" },
  { id: "identity-84", deviceId: "kandy-main-01", deviceName: "Kandy Reception", employeeNo: "84", deviceEmployeeName: "New user", eventCount: 1, firstSeenAt: "2026-08-23T04:10:00Z", lastSeenAt: "2026-08-23T04:10:00Z" },
];
