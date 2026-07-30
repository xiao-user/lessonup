import { spawnSync } from "node:child_process";

const NETWORK_NAME = "lessonup-local-network";

function redactSensitiveOutput(output) {
  return output
    .replace(/("?(?:ANON_KEY|PUBLISHABLE_KEY|SECRET_KEY|SERVICE_ROLE_KEY|JWT_SECRET|S3_PROTOCOL_ACCESS_KEY_ID|S3_PROTOCOL_ACCESS_KEY_SECRET)"?\s*[:=]\s*)"?[^"\n]+"?/g, "$1\"[redacted]\"")
    .replace(/(postgresql:\/\/[^:]+:)[^@]+(@)/g, "$1[redacted]$2");
}

function run(command, args, { allowFailure = false, quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: quiet ? "pipe" : "inherit",
    encoding: quiet ? "utf8" : undefined,
  });

  if (result.error) throw result.error;
  if (quiet && result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (output) console.error(redactSensitiveOutput(output));
  }
  if (!allowFailure && result.status !== 0) process.exit(result.status ?? 1);
  return result.status ?? 1;
}

function ensureLocalNetwork() {
  const exists = spawnSync("docker", ["network", "inspect", NETWORK_NAME], {
    stdio: "ignore",
  }).status === 0;

  if (!exists) {
    run("docker", [
      "network",
      "create",
      "-o",
      "com.docker.network.bridge.host_binding_ipv4=127.0.0.1",
      NETWORK_NAME,
    ]);
  }
}

function start() {
  ensureLocalNetwork();
  run("npx", ["supabase", "start", "--network-id", NETWORK_NAME], { quiet: true });
  console.log("Supabase local development setup is running.");
}

const action = process.argv[2];

if (action === "start") {
  start();
} else if (action === "stop") {
  run("npx", ["supabase", "stop"]);
} else if (action === "status") {
  const result = spawnSync("npx", ["supabase", "status"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (output) console.log(redactSensitiveOutput(output));
  if (result.status !== 0) process.exit(result.status ?? 1);
} else if (action === "reset") {
  ensureLocalNetwork();
  run("npx", ["supabase", "db", "reset", "--network-id", NETWORK_NAME]);
} else {
  console.error("Usage: node scripts/supabase-local.mjs <start|stop|reset|status>");
  process.exit(1);
}
