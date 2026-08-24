# Firebase Architecture

## Runtime topology

```text
Hikvision terminal
  -> Infact HikBridge (durable local queue)
  -> HTTPS Cloud Function: hikbridgeV1Events
  -> per-device HMAC verification + replay claim
  -> immutable organizations/{org}/attendanceEvents/{eventId}
  -> identity resolution / unmapped aggregate
  -> attendance recalculation jobs
  -> organizations/{org}/attendanceDays/{employee-date}
  -> authenticated Next.js operations dashboard
```

Firebase Authentication identifies dashboard users. Membership documents under each organization assign organization roles. Cloud Functions use the Admin SDK and are responsible for bridge ingestion, provisioning, mapping, immutable adjustments, calculations, and large exports. Browser clients never write raw attendance events, devices, credentials, derived attendance, or audit documents directly.

On first login, a user profile with no `defaultOrganizationId` enters the required setup wizard. The browser validates organization identity/timezone, primary branch, and default shift policy, then writes the organization, owner membership, branch, shift, profile link, and creation audit in one transaction. Bootstrap-only Rules independently constrain the complete after-state with strict field allowlists and fixed ownership/audit values. Existing organization IDs, partial writes, altered roles, and users who already have an organization fail closed. The equivalent authenticated callable is retained for a future Blaze deployment.

## Multi-tenancy boundary

Tenant-owned data is nested below `organizations/{organizationId}`. This makes the tenant boundary visible in every browser path and allows Security Rules to resolve one membership document from the path. It also makes organization deletion/export and tenant-scoped listeners deliberate.

Two server-only top-level collections are exceptions:

- `bridgeDeviceRegistry` resolves an authenticated device header to its organization, branch, public device path, status, and Secret Manager version references.
- `_bridgeReplay` stores short-lived nonce/body-hash claims used to detect conflicting replay attempts.

Security Rules deny both collections to all web clients, including users with a platform-admin claim. Admin SDK code bypasses Rules and must enforce its own authorization checks.

Bridge device IDs are globally unique within a Firebase project in protocol v1 because authentication begins with only `X-HikBridge-Device`. Provisioning rejects a duplicate even when it belongs to another tenant. A future protocol can introduce an opaque bridge registration ID if customers need repeated human-friendly local IDs.

## Ingestion sequence

1. Reject non-POST, non-JSON, and oversized requests.
2. Validate protocol, device, timestamp, nonce, and signature header shapes.
3. Resolve the global device registry and active Secret Manager versions. Secret values use a bounded five-minute process cache keyed by immutable version name; concurrent misses collapse to one access.
4. Recompute the protocol-v1 signature and compare with `timingSafeEqual`.
5. Validate header/body identity, probe rules, batch size, event IDs, event fields, raw size, and timestamp range.
6. Claim the device/nonce/body hash transactionally. The same nonce plus identical body is an idempotent retry; different bytes are a conflict.
7. Read deterministic event document references and identity mappings in a Firestore transaction.
8. Create missing raw events, classify existing IDs as duplicates, update unmapped identity aggregates, and update the public device projection.
9. Return every submitted ID exactly once as accepted, duplicate, or rejected.

A network timeout after commit is safe because retrying the deterministic event IDs returns duplicates.

The bridge also sends a signed probe every 60 seconds with terminal connectivity, last successful poll, pending local count, and bounded model/serial/firmware metadata. A probe creates no attendance event. It updates device `lastSeen` and online/offline state; the dashboard independently treats five minutes without any bridge contact as offline so a stopped service cannot remain falsely online.

## Secrets and provisioning

Provisioning is an authenticated callable restricted to organization owners and HR admins (or a platform-admin claim). It reserves the globally unique device ID, creates a replicated Secret Manager secret, adds a 256-bit random bridge credential, creates the public tenant device, and activates the server-only registry.

The credential is returned only by the create/rotate callable response. It is never written to a public device document, browser-readable Firestore path, structured log, package, or installer. Secret Manager access is performed by the Functions service account and should be limited to the relevant secrets.

Rotation adds a new Secret Manager version and permits the previous version for 15 minutes. The administrator must place the newly displayed credential in HikBridge and run `test-cloud` during this window. Expired versions remain in Secret Manager for audit/recovery until an authorized maintenance process disables them; ingestion stops referencing them immediately after the grace window.

## Employee identities

`deviceIdentities` maps the hash of `(deviceId, employeeNo)` to a cloud employee. Many identity documents may point to the same employee, allowing one employee to exist on multiple terminals without making Firestore employee IDs equal to device user numbers.

Unresolved events update one `unmappedIdentities` aggregate rather than generating a browser query over the whole raw event collection. Mapping writes an immutable mapping-audit entry and a pending recalculation job. Raw events are not rewritten after mapping.

## Attendance processing

An `attendanceEvents` create trigger recalculates the mapped employee's local event date and previous date to cover overnight shifts. The shared recalculation service resolves the historical shift assignment, mapped immutable events, branch holiday, approved leave, and approved corrections before replacing the deterministic attendance-day projection.

Identity mapping does not backfill fields into raw events. A scheduled, single-instance worker pages matching `(deviceId, employeeNo)` evidence and recalculates affected dates through the same service. HR-triggered recalculation and manual-correction callables also use this path. Leave/holiday triggers create deterministic jobs only when absent, and poison jobs become failed after five attempts. Calculation rules and edge-case behavior are frozen in `ATTENDANCE_ENGINE.md`.

## Regions, limits, and costs

Initial Functions use `asia-south1` to keep latency near Sri Lankan deployments. Organizations carry an IANA timezone and attendance calculations must use it rather than the Functions runtime timezone.

The ingestion limit is 100 events and 1 MiB per request, with 64 KiB maximum raw JSON per event. A successful new-event batch consumes reads for event existence/mappings plus raw-event/unmapped/device writes. Retry batches incur reads but no duplicate raw writes. Composite indexes are limited to known dashboard and processing queries.

Replay records have `expiresAt`; production should enable a Firestore TTL policy on that field. TTL deletion is asynchronous and is cleanup only—the timestamp window remains the authorization control.

## Local development

The cloud workspace uses TypeScript, Vitest, Firebase Emulator Suite, and Firestore Rules unit tests.

```powershell
cd cloud
npm install
npm run lint
npm run typecheck
npm test
npm run test:rules
```

Use project IDs beginning with `demo-` for emulator-only tests. Never point automated tests at production.
