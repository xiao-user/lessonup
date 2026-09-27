import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const apply = process.argv.includes("--apply");
const limit = numericArgument("--limit");
const bucket = "presentation-private";
const destinationBucket = "lessonup-private";
const sourceContainer = "supabase_storage_lessonup";

type SourceObject = {
  id: string;
  name: string;
  version: string;
  size: number;
  contentType: string | null;
};

await main();

async function main() {
  const objects = (await loadSourceObjects()).slice(0, limit ?? undefined);
  const totalBytes = objects.reduce((sum, object) => sum + object.size, 0);
  console.log(`${apply ? "Applying" : "Dry-running"} Supabase Storage → R2 import: ${objects.length} objects, ${totalBytes} bytes.`);
  validateObjects(objects);

  if (!apply) {
    for (const object of sample(objects)) console.log(`Would copy ${object.name} (${object.size} bytes).`);
    return;
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "lessonup-r2-import-"));
  try {
    let completed = 0;
    let copiedBytes = 0;
    for (const group of chunk(objects, 4)) {
      await Promise.all(group.map(async (object) => {
        await copyObject(object, temporaryDirectory);
        completed += 1;
        copiedBytes += object.size;
        console.log(`Copied ${completed}/${objects.length}: ${object.name}`);
      }));
    }
    await verifySamples(objects, temporaryDirectory);
    console.log(`Copied ${completed} objects (${copiedBytes} bytes) into R2 bucket ${destinationBucket}.`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function loadSourceObjects(): Promise<SourceObject[]> {
  const query = `SELECT json_build_object(
    'id', id::text,
    'name', name,
    'version', version,
    'size', coalesce((metadata->>'size')::bigint, 0),
    'contentType', nullif(metadata->>'mimetype', '')
  )::text
  FROM storage.objects
  WHERE bucket_id = '${bucket}'
  ORDER BY name;`;
  const { stdout } = await execute("docker", [
    "exec", "supabase_db_lessonup", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", query,
  ], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.split("\n").filter(Boolean).map((line) => {
    const value = JSON.parse(line) as SourceObject;
    return { ...value, size: Number(value.size) };
  });
}

function validateObjects(objects: SourceObject[]) {
  const names = new Set<string>();
  for (const object of objects) {
    if (!isUuid(object.id) || !isUuid(object.version) || !isSafeObjectKey(object.name) || !Number.isSafeInteger(object.size) || object.size < 0) {
      throw new Error(`Unsafe source Storage object: ${object.name}`);
    }
    if (names.has(object.name)) throw new Error(`Duplicate source Storage object key: ${object.name}`);
    names.add(object.name);
  }
}

async function copyObject(object: SourceObject, temporaryDirectory: string) {
  const localPath = join(temporaryDirectory, object.id);
  // Supabase Storage's local file backend uses the immutable object version
  // as the physical file name; `id` identifies the database record only.
  const sourcePath = `/mnt/stub/stub/${bucket}/${object.name}/${object.version}`;
  await withRetry(`copy ${object.name} from source Storage`, () => execute("docker", [
    "cp", `${sourceContainer}:${sourcePath}`, localPath,
  ]));
  try {
    const copied = await stat(localPath);
    if (copied.size !== object.size) {
      throw new Error(`Source Storage size mismatch for ${object.name}: expected ${object.size}, received ${copied.size}.`);
    }
    const args = ["wrangler", "r2", "object", "put", `${destinationBucket}/${object.name}`, "--remote", "--file", localPath];
    if (object.contentType) args.push("--content-type", object.contentType);
    await withRetry(`upload ${object.name} to R2`, () => execute("npx", args, { cwd: new URL("..", import.meta.url) }));
  } finally {
    await rm(localPath, { force: true });
  }
}

async function verifySamples(objects: SourceObject[], temporaryDirectory: string) {
  for (const object of sample(objects)) {
    const localPath = join(temporaryDirectory, `verify-${object.id}`);
    try {
      await withRetry(`download ${object.name} from R2`, () => execute("npx", [
        "wrangler", "r2", "object", "get", `${destinationBucket}/${object.name}`, "--remote", "--file", localPath,
      ], { cwd: new URL("..", import.meta.url) }));
      const body = await readFile(localPath);
      if (body.byteLength !== object.size) throw new Error(`R2 verification size mismatch for ${object.name}.`);
      console.log(`Verified R2 sample ${object.name} (${sha256(body).slice(0, 12)}).`);
    } finally {
      await rm(localPath, { force: true });
    }
  }
}

async function withRetry<T>(description: string, action: () => Promise<T>): Promise<T> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt === maxAttempts) throw new Error(`${description} failed: ${failureSummary(error)}`);
      console.warn(`${description} failed; retrying (${attempt}/${maxAttempts}).`);
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw new Error(`${description} did not return a result.`);
}

function sample<T>(items: T[]) {
  return [...new Set([items[0], items[Math.floor(items.length / 2)], items.at(-1)].filter(Boolean))] as T[];
}

function chunk<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function isSafeObjectKey(value: string) {
  return Boolean(value) && !value.startsWith("/") && !value.includes("\\0")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function numericArgument(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function failureSummary(error: unknown) {
  const stderr = typeof error === "object" && error !== null && "stderr" in error
    ? String((error as { stderr?: unknown }).stderr ?? "")
    : "";
  return stderr.split("\n").map((line) => line.trim()).find(Boolean) || "command failed";
}
