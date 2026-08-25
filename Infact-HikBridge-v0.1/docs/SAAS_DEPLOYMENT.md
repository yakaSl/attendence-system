# Infact Pulse SaaS deployment

This release uses Firebase App Hosting for the Next.js application and the existing Firebase project for Authentication, Firestore, and Cloud Functions. App Hosting is the supported full-stack Next.js path; the billing and HikBridge APIs remain independent second-generation Cloud Functions in `asia-south1`.

## 1. Dodo catalog

Create eight recurring products in Dodo test mode. Do not add a product-level trial; checkout supplies the organization-aware 14-day trial.

| Package | Monthly | Annual | Employees | Devices | Branches |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bronze | LKR 4,900 | LKR 49,000 | 25 | 1 | 1 |
| Silver | LKR 9,900 | LKR 99,000 | 100 | 3 | 3 |
| Gold | LKR 19,900 | LKR 199,000 | 300 | 10 | 10 |
| Platinum | LKR 39,900 | LKR 399,000 | 1,000 | 25 | Unlimited |

Use a one-month frequency for each monthly product and a one-year frequency for each annual product. Keep the currency as LKR. Copy each `pdt_...` identifier; a platform administrator maps these identifiers from `/platform` after deployment. Disabling a mapping stops new checkouts for that package-cycle without changing existing subscriptions.

## 2. Cloud Functions configuration

From `cloud/`, authenticate the Firebase CLI and create the two secrets:

```powershell
firebase login
firebase functions:secrets:set DODO_PAYMENTS_API_KEY
firebase functions:secrets:set DODO_PAYMENTS_WEBHOOK_KEY
```

Copy `functions/.env.example` to `functions/.env.infact-attendance-128ee` and set:

```dotenv
DODO_PAYMENTS_ENVIRONMENT=test_mode
SAAS_PUBLIC_URL=https://YOUR-BACKEND--infact-attendance-128ee.REGION.hosted.app
```

Deploy the security rules, indexes, and functions:

```powershell
firebase deploy --only firestore:rules,firestore:indexes,functions
```

Do not put either Dodo secret in the Next.js environment or Firestore. The API key is available only to functions that call Dodo; the webhook key is attached only to the signed webhook function.

## 3. Dodo webhook

In the Dodo dashboard, create a webhook pointing to:

```text
https://asia-south1-infact-attendance-128ee.cloudfunctions.net/dodoPaymentsWebhook
```

Subscribe to the subscription events: active, updated, renewed, plan changed, on hold, paused, unpaused, cancelled, failed, and expired. Copy the webhook signing key into `DODO_PAYMENTS_WEBHOOK_KEY` if it was not already set, then redeploy the webhook function.

The endpoint verifies the Standard Webhooks signature against the unmodified request body, stores an idempotent receipt, ignores older out-of-order state, and projects a sanitized entitlement into `organizations/{organizationId}/subscription/current`.

## 4. App Hosting

The deployable configuration is `web/apphosting.yaml`. In Firebase Console open **Hosting & Serverless > App Hosting**, create a backend, connect the repository, and set the app root to the `web` directory containing `package.json`. Use the closest supported region to Sri Lanka and enable automatic rollouts from the production branch.

The same setup can be started from the CLI:

```powershell
firebase apphosting:backends:create --project infact-attendance-128ee
```

After the backend is created, push to its live branch or trigger a rollout:

```powershell
firebase apphosting:rollouts:create YOUR_BACKEND_ID --git_branch main
```

Replace `SAAS_PUBLIC_URL` with the final `hosted.app` or custom-domain URL and redeploy Functions before testing checkout. Add that domain to Firebase Authentication > Settings > Authorized domains.

### HikBridge installer download

Code-sign the versioned Windows installer, publish it to an HTTPS location, and configure the App Hosting runtime variable below:

```dotenv
HIKBRIDGE_INSTALLER_URL=https://downloads.example.com/Infact-HikBridge-Setup-0.1.2.exe
```

The Devices page links to the stable SaaS path `/downloads/hikbridge`; that route validates the configured HTTPS location and redirects to the current signed release. Update only the runtime variable when publishing a new version. If the variable is missing or invalid, the route fails closed instead of distributing an unsigned or insecure artifact.

## 5. First platform administrator

Create the owner account through `/signup`, complete organization onboarding, then copy its Firebase Authentication UID. From `cloud/` run:

```powershell
npm run set:platform-admin -- --project infact-attendance-128ee --uid FIREBASE_AUTH_UID --enabled true
```

The command preserves other custom claims. Sign out and back in so the refreshed ID token contains `platformAdmin: true`, then open `/platform` and map all eight Dodo products.

## 6. Staging acceptance gate

Keep Dodo in `test_mode` until all cases pass:

1. A new owner can sign up, complete onboarding, and reach package selection.
2. Monthly and annual checkout each create the intended LKR subscription.
3. The 14-day trial is offered once per organization and the signed webhook unlocks the workspace.
4. A second checkout is rejected while access is active.
5. Employee, device, and branch creation stop exactly at package limits.
6. Dodo customer portal opens for organization owners.
7. Platform pause restricts the workspace; resume restores it; bridge ingestion retains punch evidence while restricted.
8. Manual activation creates access without a provider invoice and records the reason and term.
9. Duplicate and out-of-order webhooks do not roll subscription state backward.
10. Firestore Rules emulator, Cloud unit tests, web tests, lint, typecheck, and production build all pass.

Only after this gate should `DODO_PAYMENTS_ENVIRONMENT` be changed to `live_mode`, live product IDs mapped, and live Dodo keys installed.
