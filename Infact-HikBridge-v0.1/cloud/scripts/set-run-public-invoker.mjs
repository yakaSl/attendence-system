import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const firebaseAuth = require("firebase-tools/lib/auth");
const cloudRun = require("firebase-tools/lib/gcp/run");

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

async function main() {
  const values = argumentsFrom(process.argv.slice(2));
  const project = required(values, "project");
  const region = required(values, "region");
  const service = required(values, "service");
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) throw new Error("--project is invalid");
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(region)) throw new Error("--region is invalid");
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(service)) throw new Error("--service is invalid");

  const account = firebaseAuth.getProjectDefaultAccount(process.cwd()) ?? firebaseAuth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI is not authenticated; run firebase login first");
  firebaseAuth.setActiveAccount({}, account);
  const serviceName = `projects/${project}/locations/${region}/services/${service}`;
  await cloudRun.setInvokerUpdate(project, serviceName, ["public"]);
  process.stdout.write(`Public Cloud Run invoker enabled for ${serviceName}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
