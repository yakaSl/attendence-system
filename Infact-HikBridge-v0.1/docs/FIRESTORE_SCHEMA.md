# Firestore Schema

Dates called `date` use organization-local `YYYY-MM-DD`. Times are Firestore `Timestamp` unless described otherwise. Every tenant-owned document repeats `organizationId` where it supports exports, server assertions, or collection-group operations; path ownership remains authoritative.

## Server-only top-level collections

### `bridgeDeviceRegistry/{deviceId}`

Global authentication lookup. Browser access denied.

```typescript
{
  state: "provisioning" | "active" | "provisioning_failed",
  enabled: boolean,
  organizationId: string,
  branchId: string,
  deviceDocumentPath: string,
  secretResourceName: string,
  secretVersionNames: string[],
  previousSecretValidUntil?: Timestamp,
  createdAt: Timestamp,
  activatedAt?: Timestamp
}
```

No raw secret is stored here.

### `_bridgeReplay/{sha256(deviceId + nonce)}`

```typescript
{
  deviceId: string,
  organizationId: string,
  bodyHash: string,
  receivedAt: Timestamp,
  expiresAt: Timestamp
}
```

Enable Firestore TTL on `expiresAt`.

### `users/{uid}`

Global non-authoritative user profile. Tenant roles live in membership documents. A custom `platformAdmin` claim is reserved for tightly controlled platform staff.

## Organization root

### `organizations/{organizationId}`

```typescript
{
  name: string,
  timezone: string, // IANA, initially Asia/Colombo where appropriate
  status: "active" | "suspended",
  attendancePolicy: {
    lateMinutesMode: "from_shift_start" | "after_grace",
    missingPunchPolicy: string
  },
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

### `members/{uid}`

```typescript
{
  role: "organizationOwner" | "hrAdmin" | "manager" | "viewer",
  active: boolean,
  branchIds?: string[],
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

Branch restrictions are reserved in the model. Before they are enabled, Rules and server queries must be updated together.

### `branches/{branchId}`

Name, timezone override if needed, address metadata, status, and timestamps. Private LAN addresses are not stored by default.

### `departments/{departmentId}`

Name, code, status, and timestamps.

### `devices/{deviceId}`

Browser-readable operational projection, never credentials:

```typescript
{
  id: string,
  localDeviceId: string,
  name: string,
  branchId: string,
  deviceType: "hikvision_ds_k1a8503ef" | "hikvision_other",
  description: string,
  enabled: boolean,
  connectionStatus: "provisioned" | "online" | "offline" | "error",
  lastSeen?: Timestamp,
  lastEventAt?: Timestamp,
  lastSuccessfulDevicePoll?: Timestamp,
  pendingLocalEvents?: number,
  bridgeVersion?: string,
  deviceModel?: string,
  deviceSerial?: string,
  firmwareVersion?: string,
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

### `employees/{employeeId}`

```typescript
{
  employeeCode: string,
  name: string,
  departmentId?: string,
  branchId: string,
  status: "active" | "inactive",
  hireDate?: string,
  terminationDate?: string,
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

The document ID is a cloud identity, not a Hikvision employee number.

`employeeCodeRegistry/{sha256(lowercaseEmployeeCode)}` prevents concurrent duplicate employee codes. `employeeCreationAudits/{auditId}` records the actor and created identity. `employeeDepartmentChangeAudits/{auditId}` records the previous department, new department, reason, and actor for every reassignment. All are server-written; the registry is browser-inaccessible and audits are HR-readable.

### `devices/{deviceId}/commands/{commandId}`

Server-only short-lived commands for the HMAC-authenticated bridge. A command stores type (`upsert_user` or `enroll_fingerprint`), employee identity fields, optional finger slot, state, lease/expiry timestamps, bounded result metadata, and audit fields. Fingerprint templates are prohibited. `devices/{deviceId}/commandLocks/fingerprint` permits only one active capture prompt per terminal.

### `deviceEnrollments/{sha256(deviceId + employeeNo)}`

HR-readable projection of user synchronization/fingerprint enrollment state. It contains device/employee IDs, employee number, state, finger slot, optional terminal-reported quality, safe last error, and timestamps. It never contains `fingerData`.

### `deviceIdentities/{sha256(deviceId + employeeNo)}`

```typescript
{
  deviceId: string,
  branchId: string,
  employeeNo: string,
  employeeId: string,
  active: boolean,
  updatedAt: Timestamp,
  updatedBy: string
}
```

Many identities may reference one employee.

### `unmappedIdentities/{identityKey}`

Operational aggregate containing device/user identity, state, event count, first/last event times, and resolution metadata. It prevents whole-database scans for unmapped punches.

### `identityMappingAudits/{auditId}`

Immutable previous/new employee mapping, reason, actor, and timestamp.

## Immutable source events

### `attendanceEvents/{deterministicEventId}`

```typescript
{
  id: string,
  organizationId: string,
  branchId: string,
  deviceId: string,
  deviceSerial?: string,
  serialNo?: number,
  employeeNo: string,
  employeeId?: string, // only when resolved at ingestion
  deviceEmployeeName: string,
  eventTime: Timestamp,
  major: number,
  minor: number,
  attendanceStatus: string,
  verifyMode: string,
  cardNo: string,
  cardReaderNo: number | null,
  doorNo: number | null,
  source: "hikvision",
  sourceEventId: string,
  raw: unknown,
  bridgeReceivedAt: Timestamp,
  receivedAt: Timestamp,
  ingestionRequestId: string,
  mappingStatusAtIngest: "mapped" | "unmapped"
}
```

The document is created once. Later mapping, HR corrections, and rule changes do not mutate it.

## Attendance configuration and derived data

### `shifts/{shiftId}`

Shift name, local start/end times, overnight flag, working weekdays, grace and late mode, break policy, overtime policy, early-leave policy, and status. Values are data, never hard-coded in Functions.

### `shiftAssignments/{assignmentId}`

Employee, shift, `effectiveFrom`, optional `effectiveTo`, source/reason, actor, and timestamps. Assignments are date-ranged; an employee document never overwrites historical shift truth.

### `shiftChangeAudits/{auditId}` and `shiftAssignmentAudits/{auditId}`

Server-created before/after policy changes and immutable assignment actions with reason, actor, and timestamp. Browser reads are HR-only and browser writes are denied.

### `shiftInferences/{employeeId}_{date}`

Daily derived shift suggestion for an employee without an explicit assignment. High-confidence matches are applied only to that attendance day. Medium and ambiguous matches remain `review_required` until HR confirms or rejects them. Resolutions are stored in `shiftInferenceAudits/{auditId}` and trigger deterministic attendance recalculation.

### `holidays/{holidayId}`

Local date or date range, branch scope, name, working/non-working behavior, and audit fields.

### `leaveRequests/{leaveId}`

Employee, local date range, leave type, approval status/actor/timestamps, partial-day information, and reason.

### `manualAdjustments/{adjustmentId}`

Immutable approved adjustment command: employee/date, `kind`, optional corrected instant/status, reason, actor, approval timestamp, idempotency hash, and the old calculated state. The document ID is the caller's UUID idempotency key. Original events remain separate.

### `adjustmentAudits/{auditId}`

Immutable old calculated state, adjustment snapshot, resulting calculated state, reason, actor, and calculation version.

### `attendanceDays/{employeeId_date}`

Derived, replaceable projection containing organization timezone; shift and local work date; local and instant schedule/check-in/check-out values; worked/late/early/overtime minutes; status; holiday/leave references; exception flags; source event IDs; adjustment IDs; `attendance-v2` calculation version; and `calculatedAt`. See `ATTENDANCE_ENGINE.md` for formulas and precedence.

### `recalculationJobs/{jobId}`

Server work queue for identity mapping, shift/rule changes, and leave/holiday changes. Jobs page with deterministic cursors/counters and are safe for the single-instance scheduled worker to retry. Persistent processing failures move to `state: "failed"` after five attempts so one poison item cannot starve pending work.

### `reports/{reportId}`

Server-generated report job metadata, filters, status, output reference, expiry, actor, and timestamps. Large report data is not downloaded from all Firestore collections into a browser.
