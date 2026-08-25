# Attendance Dashboard

## Purpose and visual direction

`web/` is the desktop-first HR operations application. Its hierarchy begins with workforce status and exceptions, not a marketing hero. A dark fixed navigation rail, neutral working canvas, dense tables, restrained borders, and one teal action/status accent keep attention on evidence and decisions. Motion is limited to navigation, overlays, and data-state feedback.

The application uses Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4, Firebase Authentication, modular Cloud Firestore/Functions clients, Lucide icons, and the Temporal polyfill for timezone-safe correction instants.

## Routes

- `/login`: Firebase email/password sign-in. Demo mode clearly identifies non-persistent sample access.
- `/dashboard`: today metrics, total late/overtime time, missing punches, offline devices, seven-day pulse, exceptions, attendance, and bridge health.
- `/employees`: indexed employee view with search/filters and HR-only unmapped-device identity workflow.
- `/employees/[employeeId]`: employee context, month navigation, summary metrics, and full daily attendance table.
- `/attendance`: date/employee/department/status/branch filters and HR-only immutable correction workflow.
- `/shifts`: validated normal/overnight policy management and date-ranged employee assignments.
- `/devices`: cloud heartbeat, device state, one-time provisioning credential, rotation, and enable/disable actions. Stored credentials are never queried.
- `/reports`: seven report views, 31-day/5,000-row interactive cap, and UTF-8 CSV export.
- `/settings`: organization/timezone/role context, integration signals, role matrix, and trust-boundary reminders.

All routes are responsive. On narrow screens the rail becomes an overlay and secondary operational columns collapse before primary identity/status content.

HikBridge sends a signed health report every four minutes. The Devices view honors the terminal's reported online/offline state and treats six minutes without bridge contact as offline, which also covers a stopped PC/service. Health metadata never includes the terminal password, bridge key, signature, or private LAN address.

## Authentication and tenant selection

Production mode initializes Firebase only in the browser. After authentication it reads `users/{uid}.defaultOrganizationId`, then the corresponding `organizations/{organizationId}/members/{uid}` document. The membership supplies the role used for UI affordances; Firestore Rules and callable authorization remain the enforcement boundaries.

Expected user profile:

```json
{
  "displayName": "HR Manager",
  "defaultOrganizationId": "organization-id"
}
```

Demo mode does not initialize Firebase. It uses a clearly labelled, in-memory fixture repository and makes mutation calls non-persistent.

## Read and write boundary

Normal lists use browser Firestore queries that are tenant-path scoped, indexed, and capped. Repository methods never issue a collection-group query across organizations. Attendance range queries cap at 5,000 derived rows; interactive reports reject ranges over 31 days. Larger production exports should use server-generated report jobs.

High-impact writes use authenticated callables:

- `mapDeviceIdentity`
- `createManualAdjustment`
- `saveShift`
- `assignEmployeeShift`
- `provisionDevice`
- `rotateDeviceCredential`
- `setDeviceEnabled`

Shift writes are denied directly by Rules. The callables validate policy fields, authorize HR roles, append audits, and enqueue recalculation. Manual corrections never mutate a raw event. Provision and rotation responses show a new bridge key only once.

Employee, leave, and holiday CRUD currently remain governed by the existing HR Firestore rules. Leave and holiday document changes enqueue date-range recalculation through server triggers.

## Local setup

```powershell
cd web
Copy-Item .env.example .env.local
npm install
npm run dev
```

For the sample workspace, leave `NEXT_PUBLIC_DEMO_MODE=true`. For Firebase, set it to `false`, fill every required Firebase web config variable, enable the intended Authentication provider, create the user/profile/membership documents, and authorize the local domain.

Verification:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

No dashboard deployment is performed by repository tests. Use a staging Firebase project and validated environment variables before any production hosting action.
