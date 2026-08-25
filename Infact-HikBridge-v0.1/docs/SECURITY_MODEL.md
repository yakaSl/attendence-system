# Security Model

## Trust boundaries

- Hikvision is a local event source, not a cloud identity provider.
- HikBridge is trusted only after per-device HMAC verification. It cannot use Firebase Admin APIs.
- Cloud Functions are the only writers for raw events, derived attendance, device status, credentials, mapping audits, adjustment audits, and report outputs.
- Browser users authenticate with Firebase Authentication and remain constrained by Firestore Security Rules and callable authorization.
- Realtime bridge sessions use short-lived Firebase custom tokens whose claims restrict RTDB reads to one organization/device control path. Firestore commands and the per-device HMAC remain authoritative.
- Firestore Admin SDK and Secret Manager access belong to service accounts with least privilege.

## Local administrator setup

The temporary configuration UI binds explicitly to `127.0.0.1`; configuration validation rejects public diagnostic binds. A random launch token is consumed once to create an HttpOnly SameSite session. API requests require the session, exact loopback Host/Origin, and a separate CSRF value. CSP, frame denial, no-store, and browser permission restrictions reduce local-browser attack surface.

The browser receives only non-secret fields and booleans indicating whether a password/bridge credential exists. Blank secret inputs preserve stored values. The server never sends the stored value back. Save creates a restrictive ProgramData directory, atomically replaces the validated JSON, then installs/starts or restarts the service.

## Bridge authentication

Protocol v1 signs version, globally unique device ID, current Unix timestamp, a 128-bit nonce, and SHA-256 of the exact body. The backend:

- rejects malformed headers before expensive work;
- enforces a five-minute skew window;
- retrieves only active Secret Manager versions for that device;
- uses timing-safe comparison;
- verifies body/header device and nonce equality;
- transactionally claims nonce plus body hash;
- rejects a nonce reused with different bytes;
- validates batch/body/raw limits and event identity;
- uses deterministic event documents for idempotency.

Authentication failures return generic messages and structured error codes. Logs include device ID and error category where safe, never the bridge key, signature, nonce/body, Hikvision password, raw event, or authorization headers.

## Secret lifecycle

Credentials are generated from 256 bits of cryptographic randomness. Secret Manager stores the only server-readable value. Firestore stores version resource names in a server-only registry. The create/rotate callable shows the credential once in its TLS-protected response.

Rotation permits old and new credentials for 15 minutes. Disable a device immediately if a credential may be compromised, rotate it, update local HikBridge configuration, run `test-cloud`, and re-enable only after verification. Public installers and documentation never contain customer credentials.

The Functions runtime service account requires Secret Manager accessor on bridge secrets. Device lifecycle callables additionally require secret create, version-add, and secret-delete permissions. Permanent device removal revokes the Firestore registry before deleting the secret and keeps an organization-scoped deletion audit. Separate these functions/service accounts in a higher-assurance deployment if organization policy requires it.

## Browser authorization

Roles:

- `platformAdmin`: custom claim for tightly controlled platform operations.
- `organizationOwner`: organization membership and settings administration.
- `hrAdmin`: employees, shifts, mappings, leave, and HR operations.
- `manager`: operational attendance visibility; no credential or HR-configuration writes.
- `viewer`: read-only normal organization views.

Organization membership documents are authoritative for tenant roles. A client-provided `organizationId` is never sufficient. Rules resolve membership from the organization path and authenticated UID. Callables repeat authorization with Admin SDK reads because Admin SDK bypasses Rules.

First-login organization creation is the narrow exception to normal membership-based writes. An authenticated user may submit one atomic Firestore transaction containing the organization, owner membership, primary branch, default shift, user profile link, and creation audit. Bootstrap-only Rules use `getAfter`/`existsAfter`, strict field allowlists, fixed owner/audit values, an unused organization path, and the user's pre-write profile to require the complete document set and refuse a second organization. No individual bootstrap document can be created through this exception. The equivalent `bootstrapOrganization` callable remains available when the project is upgraded to Blaze.

Raw attendance events deny all browser writes, including platform-admin clients. Platform repair uses controlled server tooling with its own audit rather than browser SDK writes.

Employee creation and fingerprint enrollment are HR/owner callables. Browsers cannot write the employee-code registry, device command queue, command lock, or enrollment projection. A command is accepted only by the HMAC-authenticated bridge registered to that exact organization/device, and a terminal must belong to the employee's branch. Only one unexpired fingerprint prompt can be active per terminal.

Biometric templates never cross the cloud trust boundary. The bridge keeps a captured template in memory only long enough to assign it back to the same LAN terminal. Local durable state and Firestore contain command/result metadata only: employee identifiers, finger slot, state, quality, timestamps, and bounded error text.

Realtime Database contains only an overwrite-only command ID/revision signal. A signal cannot create, alter, or authorize a command. Global RTDB access is denied; a bridge token can read only its own signal and can write only its strictly validated presence record. Emulator tests verify same-tenant and cross-device denial.

## Tenant isolation

All browser-readable business data is nested under its organization. Rules require active membership in that exact path. Tests cover allowed same-tenant reads, forbidden cross-tenant reads/writes, role restrictions, raw-event mutation, and server-only credential paths.

Branch-scoped roles are represented but not yet enforced. Do not populate `branchIds` as a security promise until queries and Rules enforce them together.

## Evidence and audit

- Raw device event documents are create-once and client-immutable.
- Identity changes write separate mapping audits and cursor-based recalculation jobs.
- Manual corrections write immutable adjustments and before/after audits through an HR-only callable.
- Shift changes and assignments write separate audit documents and controlled recalculation jobs; browser SDK writes to these collections are denied.
- Approved leave and non-working holiday changes enqueue date-range recalculation without rewriting evidence.
- Derived attendance can be recalculated; source evidence cannot be rewritten.
- Synced and failed local bridge events remain retained for operational recovery according to the eventual retention policy.

## Operational controls

- Require HTTPS outside loopback development.
- Use separate Firebase projects for development, staging, and production.
- Enable App Check for browser-facing callable/functions where compatible; do not treat it as user authorization.
- Alert on signature failures, stale/replay conflicts, provisioning failures, unusual rejected batches, and tenant-rule test failures.
- Enable Firestore point-in-time recovery/export appropriate to the plan.
- Configure TTL for replay records and generated report artifacts.
- Review IAM, Secret Manager versions, custom claims, and organization owners regularly.
- Never use production credentials or customer event payloads in fixtures.

## Dashboard controls

The Next.js client reads only tenant-nested documents allowed by Rules. A user's own profile selects a default organization, then membership in that exact organization supplies the operational role. Hiding an action is not authorization: every high-impact callable repeats role checks with Admin SDK reads.

Interactive reporting is capped at 31 days and 5,000 derived rows. CSV is created only from that controlled result and excludes raw event payloads and credentials. Bridge keys are rendered only from the immediate provisioning/rotation response and are not persisted in browser storage by application code.
