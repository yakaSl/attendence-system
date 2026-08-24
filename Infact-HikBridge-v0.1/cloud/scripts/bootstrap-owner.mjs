import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const firebaseAuth = require("firebase-tools/lib/auth");
const firebaseApi = require("firebase-tools/lib/apiv2");

function argumentsFrom(commandLine) {
  const values = new Map();
  for (let index = 0; index < commandLine.length; index += 2) {
    const name = commandLine[index];
    const value = commandLine[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("Arguments must be supplied as --name value pairs");
    }
    values.set(name.slice(2), value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function validateId(name, value, expression) {
  if (!expression.test(value)) throw new Error(`--${name} contains unsupported characters`);
  return value;
}

function stringValue(value) {
  return { stringValue: value };
}

function timestampValue(value) {
  return { timestampValue: value };
}

function document(name, fields) {
  return { name, fields };
}

async function main() {
  const values = argumentsFrom(process.argv.slice(2));
  const project = validateId("project", required(values, "project"), /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/);
  const uid = validateId("uid", required(values, "uid"), /^[A-Za-z0-9_-]{1,128}$/);
  const organizationId = validateId("organization", required(values, "organization"), /^[a-z0-9][a-z0-9-]{1,62}$/);
  const organizationName = required(values, "name");
  const timezone = required(values, "timezone");
  const branchId = validateId("branch", required(values, "branch"), /^[a-z0-9][a-z0-9-]{1,62}$/);
  const branchName = required(values, "branch-name");

  Intl.DateTimeFormat(undefined, { timeZone: timezone }).format(new Date());

  const account = firebaseAuth.getProjectDefaultAccount(process.cwd()) ?? firebaseAuth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI is not authenticated; run firebase login first");
  firebaseAuth.setActiveAccount({}, account);
  const accessToken = await firebaseApi.getAccessToken();
  const databaseRoot = `projects/${project}/databases/(default)/documents`;
  const names = {
    user: `${databaseRoot}/users/${uid}`,
    organization: `${databaseRoot}/organizations/${organizationId}`,
    member: `${databaseRoot}/organizations/${organizationId}/members/${uid}`,
    branch: `${databaseRoot}/organizations/${organizationId}/branches/${branchId}`,
  };
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "x-goog-user-project": project,
  };

  async function readDocument(name) {
    const response = await fetch(`https://firestore.googleapis.com/v1/${name}`, { headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Could not inspect ${name}: HTTP ${response.status}`);
    return response.json();
  }

  const existing = await Promise.all(Object.values(names).map(readDocument));
  if (existing.every((value) => value !== null)) {
    const existingOrganization = existing[0]?.fields?.defaultOrganizationId?.stringValue;
    const existingRole = existing[2]?.fields?.role?.stringValue;
    if (existingOrganization === organizationId && existingRole === "organizationOwner") {
      console.log(`Owner bootstrap already exists for organization ${organizationId}.`);
      return;
    }
    throw new Error("Bootstrap documents already exist with different ownership; refusing to overwrite them");
  }
  if (existing.some((value) => value !== null)) {
    throw new Error("Partial bootstrap documents already exist; inspect them before retrying");
  }

  const now = new Date().toISOString();
  const writes = [
    document(names.user, {
      displayName: stringValue("Organization Owner"),
      defaultOrganizationId: stringValue(organizationId),
      createdAt: timestampValue(now),
      updatedAt: timestampValue(now),
    }),
    document(names.organization, {
      name: stringValue(organizationName),
      timezone: stringValue(timezone),
      status: stringValue("active"),
      attendancePolicy: {
        mapValue: {
          fields: {
            lateMinutesMode: stringValue("after_grace"),
            missingPunchPolicy: stringValue("flag_exception"),
          },
        },
      },
      createdAt: timestampValue(now),
      updatedAt: timestampValue(now),
    }),
    document(names.member, {
      role: stringValue("organizationOwner"),
      active: { booleanValue: true },
      createdAt: timestampValue(now),
      updatedAt: timestampValue(now),
    }),
    document(names.branch, {
      name: stringValue(branchName),
      timezone: stringValue(timezone),
      status: stringValue("active"),
      createdAt: timestampValue(now),
      updatedAt: timestampValue(now),
    }),
  ].map((update) => ({ update, currentDocument: { exists: false } }));

  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:commit`,
    { method: "POST", headers, body: JSON.stringify({ writes }) },
  );
  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    throw new Error(`Owner bootstrap failed with HTTP ${response.status}: ${details}`);
  }
  const result = await response.json();
  if (!Array.isArray(result.writeResults) || result.writeResults.length !== writes.length) {
    throw new Error("Firestore returned an incomplete bootstrap acknowledgement");
  }
  console.log(`Created organization ${organizationId}, owner membership, profile, and branch ${branchId}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
