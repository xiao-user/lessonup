import { execFileSync } from "node:child_process";

const dryRun = process.argv.includes("--dry-run");
const root = new URL("..", import.meta.url);

execFileSync("npm", ["run", "dashi:prepare"], { cwd: root, stdio: "inherit" });
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });

/**
 * Production runtime configuration belongs to Cloudflare Runtime Variables and
 * Secrets. A developer's local .env is only for local processes and must never
 * overwrite a deployed model endpoint, model identifier, or credential.
 */
const args = ["wrangler", "deploy", "--config", "wrangler.jsonc", "--keep-vars"];
if (dryRun) args.push("--dry-run");

execFileSync("npx", args, {
  cwd: root,
  stdio: "inherit",
});
