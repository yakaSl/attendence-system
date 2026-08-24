import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const firebaseAuth = require("firebase-tools/lib/auth");
const firebaseApi = require("firebase-tools/lib/apiv2");

function argumentsFrom(commandLine) {
  const values = new Map();
  for (let index = 0; index < commandLine.length; index += 2) {
    const name = commandLine[index];
    const value = commandLine[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error("Arguments must be supplied as --name value pairs");
    values.set(name.slice(2), value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function request(url, accessToken, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Identity Platform request failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function main() {
  const values = argumentsFrom(process.argv.slice(2));
  const project = required(values, "project");
  const uid = required(values, "uid");
  const enabled = (values.get("enabled") ?? "true").toLowerCase() === "true";
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) throw new Error("--project is invalid");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error("--uid is invalid");

  const account = firebaseAuth.getProjectDefaultAccount(process.cwd()) ?? firebaseAuth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI is not authenticated; run firebase login first");
  firebaseAuth.setActiveAccount({}, account);
  const accessToken = await firebaseApi.getAccessToken();
  const root = `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts`;
  const lookup = await request(`${root}:lookup`, accessToken, { localId: [uid] });
  const user = lookup.users?.[0];
  if (!user) throw new Error("Firebase Authentication user was not found");
  let claims = {};
  if (typeof user.customAttributes === "string" && user.customAttributes.length > 0) {
    const parsed = JSON.parse(user.customAttributes);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) claims = parsed;
  }
  if (enabled) claims.platformAdmin = true;
  else delete claims.platformAdmin;
  await request(`${root}:update`, accessToken, { localId: uid, customAttributes: JSON.stringify(claims) });
  process.stdout.write(`platformAdmin=${enabled} set for ${uid}. The user must sign out and sign in again.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
