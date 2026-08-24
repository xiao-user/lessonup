import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, hasSupabase } from "../config.js";
import type { NativeDashiBundle } from "./native-dashi-skill.js";

const bucket = "presentation-private";
const manifestName = "manifest.json";
const runtimeRoot = "dashi-runtime";

/**
 * Storage rejects a literal `Content-Type: undefined` header.  Dashi bundles
 * contain more than HTML (its first file can be a JSON state file), so every
 * persisted artifact needs a concrete type instead of delegating an undefined
 * value through the client.
 */
function contentTypeFor(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "html": case "htm": return "text/html; charset=utf-8";
    case "json": return "application/json; charset=utf-8";
    case "js": case "mjs": return "text/javascript; charset=utf-8";
    case "css": return "text/css; charset=utf-8";
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "woff": return "font/woff";
    case "woff2": return "font/woff2";
    case "ttf": return "font/ttf";
    case "otf": return "font/otf";
    case "mp3": return "audio/mpeg";
    case "mp4": return "video/mp4";
    default: return "application/octet-stream";
  }
}

type StoredManifestFile = {
  path: string;
  bytes: number;
  sha256: string;
  /** Version 1 bundles stored every file under the deck root. */
  scope?: "runtime" | "deck";
};

type StoredManifest = {
  version: 1 | 2;
  /** Immutable, content-addressed Dashi runtime for version 2 bundles. */
  runtimeKey?: string;
  files: StoredManifestFile[];
  byteSize: number;
};

type RuntimeManifest = {
  version: 1;
  files: StoredManifestFile[];
};

function assertRelativePath(value: string) {
  if (!value || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("presentation_bundle_path_invalid");
  }
  return value;
}

function storageRoot(ownerId: string, presentationId: string) {
  return `${ownerId}/presentations/${presentationId}`;
}

function manifestEntries(files: NativeDashiBundle["files"]): StoredManifestFile[] {
  return files.map((file) => ({
    path: assertRelativePath(file.path),
    bytes: file.body.byteLength,
    sha256: createHash("sha256").update(file.body).digest("hex"),
  }));
}

function manifestFor(bundle: NativeDashiBundle, runtimeFiles: NativeDashiBundle["files"], runtimeKey?: string): StoredManifest {
  const runtimePaths = new Set(runtimeFiles.map((file) => file.path));
  return {
    version: 2,
    runtimeKey,
    byteSize: bundle.byteSize,
    files: manifestEntries(bundle.files).map((entry) => ({
      ...entry,
      scope: runtimePaths.has(entry.path) ? "runtime" : "deck",
    })),
  };
}

/**
 * Dashi writes its reusable editor/export runtime alongside every deck.
 * Everything else is specific to the teacher's deck and must remain private
 * to that deck, especially staged user media and editor state.
 */
function isDeckSpecific(path: string) {
  return path === "index.html"
    || path === ".image-slots.state.json"
    || path.startsWith("assets/user-media/")
    || path.startsWith("images/")
    || path.startsWith("uploads/")
    || path.startsWith("screens/")
    || path.startsWith("screenshots/");
}

function runtimeKeyFor(files: NativeDashiBundle["files"]) {
  const fingerprint = manifestEntries(files)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path, sha256 }) => `${path}:${sha256}`)
    .join("\n");
  return `${runtimeRoot}/${createHash("sha256").update(fingerprint).digest("hex")}`;
}

/**
 * Private object storage for the exact directory Dashi renders and edits.
 * The manifest is uploaded last, so readers only see a complete bundle.
 */
export class PresentationArtifactStorage {
  private readonly client: SupabaseClient | null = hasSupabase
    ? createClient(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    : null;

  get configured() {
    return Boolean(this.client);
  }

  keyFor(ownerId: string, presentationId: string) {
    return storageRoot(ownerId, presentationId);
  }

  async save(ownerId: string, presentationId: string, bundle: NativeDashiBundle) {
    if (!this.client) throw new Error("presentation_storage_not_configured");
    const root = storageRoot(ownerId, presentationId);
    const runtimeFiles = bundle.files.filter((file) => !isDeckSpecific(file.path));
    const deckFiles = bundle.files.filter((file) => isDeckSpecific(file.path));
    const runtimeKey = await this.ensureRuntime(runtimeFiles);
    const manifest = manifestFor(bundle, runtimeFiles, runtimeKey ?? undefined);
    await this.uploadFiles(root, deckFiles);
    await this.uploadJson(`${root}/${manifestName}`, manifest);
    // A deck saved by the previous format has a full runtime under its own
    // root.  Prune it only after the version-2 manifest is committed, so an
    // interrupted migration remains readable through the old manifest.
    await this.pruneDeckFiles(root, deckFiles).catch(() => undefined);
    return {
      storageKey: root,
      // The full manifest remains available to restore Dashi, but this is the
      // actual private Storage footprint shown in the teacher's file list.
      byteSize: deckFiles.reduce((total, file) => total + file.body.byteLength, 0)
        + new TextEncoder().encode(JSON.stringify(manifest)).byteLength,
    };
  }

  async load(ownerId: string, presentationId: string, storageKey = storageRoot(ownerId, presentationId)): Promise<NativeDashiBundle> {
    if (!this.client) throw new Error("presentation_storage_not_configured");
    const manifestFile = await this.client.storage.from(bucket).download(`${storageKey}/${manifestName}`);
    if (manifestFile.error) throw new Error("presentation_storage_bundle_missing");
    const manifest = JSON.parse(await manifestFile.data.text()) as StoredManifest;
    if ((manifest.version !== 1 && manifest.version !== 2) || !Array.isArray(manifest.files)) {
      throw new Error("presentation_storage_manifest_invalid");
    }
    const files = await Promise.all(manifest.files.map(async (entry) => {
      const relative = assertRelativePath(entry.path);
      const objectKey = manifest.version === 2 && entry.scope === "runtime"
        ? manifest.runtimeKey ? `${manifest.runtimeKey}/${relative}` : null
        : `${storageKey}/${relative}`;
      if (!objectKey) throw new Error("presentation_storage_manifest_invalid");
      const result = await this.client!.storage.from(bucket).download(objectKey);
      if (result.error) throw new Error("presentation_storage_bundle_incomplete");
      const body = new Uint8Array(await result.data.arrayBuffer());
      if (body.byteLength !== entry.bytes || createHash("sha256").update(body).digest("hex") !== entry.sha256) {
        throw new Error("presentation_storage_bundle_corrupt");
      }
      return { path: relative, body };
    }));
    if (!files.some((file) => file.path === "index.html")) throw new Error("presentation_storage_manifest_invalid");
    return { files, byteSize: manifest.byteSize };
  }

  async remove(ownerId: string, presentationId: string, storageKey = storageRoot(ownerId, presentationId)) {
    if (!this.client) return;
    const paths = await this.objectPaths(storageKey);
    if (!paths.length) return;
    const removed = await this.client.storage.from(bucket).remove(paths);
    if (removed.error) throw new Error(`presentation_storage_delete_failed:${removed.error.message}`);
  }

  private async ensureRuntime(files: NativeDashiBundle["files"]) {
    if (!files.length) return null;
    const runtimeKey = runtimeKeyFor(files);
    const marker = await this.client!.storage.from(bucket).download(`${runtimeKey}/${manifestName}`);
    if (!marker.error) return runtimeKey;
    if (marker.error.statusCode && marker.error.statusCode !== "404") {
      throw new Error(`presentation_storage_runtime_lookup_failed:${marker.error.message}`);
    }
    await this.uploadFiles(runtimeKey, files);
    const runtimeManifest: RuntimeManifest = { version: 1, files: manifestEntries(files) };
    await this.uploadJson(`${runtimeKey}/${manifestName}`, runtimeManifest);
    return runtimeKey;
  }

  private async uploadFiles(root: string, files: NativeDashiBundle["files"]) {
    for (const file of files) {
      const result = await this.client!.storage.from(bucket).upload(
        `${root}/${assertRelativePath(file.path)}`,
        file.body,
        { upsert: true, contentType: contentTypeFor(file.path) },
      );
      if (result.error) throw new Error(`presentation_storage_upload_failed:${result.error.message}`);
    }
  }

  private async uploadJson(objectKey: string, value: unknown) {
    const result = await this.client!.storage.from(bucket).upload(
      objectKey,
      new Blob([JSON.stringify(value)]),
      { upsert: true, contentType: "application/json" },
    );
    if (result.error) throw new Error(`presentation_storage_upload_failed:${result.error.message}`);
  }

  private async pruneDeckFiles(root: string, files: NativeDashiBundle["files"]) {
    const keep = new Set([`${root}/${manifestName}`, ...files.map((file) => `${root}/${assertRelativePath(file.path)}`)]);
    const obsolete = (await this.objectPaths(root)).filter((path) => !keep.has(path));
    if (!obsolete.length) return;
    const removed = await this.client!.storage.from(bucket).remove(obsolete);
    if (removed.error) throw new Error(`presentation_storage_delete_failed:${removed.error.message}`);
  }

  private async objectPaths(root: string): Promise<string[]> {
    const listed = await this.client!.storage.from(bucket).list(root, { limit: 1_000 });
    if (listed.error) throw new Error(`presentation_storage_list_failed:${listed.error.message}`);
    const paths: string[] = [];
    const visit = async (prefix: string, entries: typeof listed.data) => {
      for (const entry of entries) {
        const child = `${prefix}/${entry.name}`;
        if (entry.id === null) {
          const nested = await this.client!.storage.from(bucket).list(child, { limit: 1_000 });
          if (nested.error) throw new Error(`presentation_storage_list_failed:${nested.error.message}`);
          await visit(child, nested.data);
        } else paths.push(child);
      }
    };
    await visit(root, listed.data);
    return paths;
  }
}
