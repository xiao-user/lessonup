import { execFileSync } from "node:child_process";
import { stdin, stdout } from "node:process";
import { hashPassword } from "../server/platform/passwords.js";

const loginIndex = process.argv.indexOf("--login");
const idIndex = process.argv.indexOf("--user-id");
const loginName = (loginIndex >= 0 ? process.argv[loginIndex + 1] : "admin")?.trim().toLowerCase();
const userId = (idIndex >= 0 ? process.argv[idIndex + 1] : sourceUserId())?.trim();
const password = process.env.LESSONUP_ADMIN_PASSWORD ?? await readPassword();

if (!loginName || !userId || !password) {
  throw new Error("usage: npm run d1:provision-admin -- --login admin [--user-id <uuid>]");
}

const passwordHash = await hashPassword(password);
const now = new Date().toISOString();
const sql = `INSERT INTO users (id, login_name, password_hash, created_at, updated_at)
  VALUES (${literal(userId)}, ${literal(loginName)}, ${literal(passwordHash)}, ${literal(now)}, ${literal(now)})
  ON CONFLICT(id) DO UPDATE SET login_name = excluded.login_name, password_hash = excluded.password_hash, updated_at = excluded.updated_at;`;

execFileSync("npx", ["wrangler", "d1", "execute", "lessonup", "--remote", "--command", sql], {
  stdio: "inherit",
  cwd: new URL("..", import.meta.url),
});
console.log(`Provisioned D1 login ${loginName} for migrated owner ${userId}.`);

function sourceUserId() {
  return execFileSync("docker", [
    "exec", "supabase_db_lessonup", "psql", "-U", "postgres", "-d", "postgres", "-At",
    "-c", "SELECT id::text FROM auth.users ORDER BY created_at LIMIT 1;",
  ], { encoding: "utf8" }).trim();
}

function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readPassword() {
  if (!stdin.isTTY) {
    return "";
  }

  stdout.write("请输入 admin 的新密码：");
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve) => {
    let value = "";
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const code of chunk) {
        if (code === 3) {
          process.exit(130);
        }
        if (code === 13 || code === 10) {
          finish();
          return;
        }
        if (code === 127 || code === 8) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(code);
      }
    };
    stdin.on("data", onData);
  });
}
