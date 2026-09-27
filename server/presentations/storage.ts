import { createHash } from "node:crypto";
import type { NativeDashiBundle } from "./dashi-skill-port.js";
import type { ObjectStorage } from "../platform/object-storage.js";

const manifestName = "manifest.json";

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

function assertRelativePath(value: string) {
  if (!value || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("presentation_bundle_path_invalid");
  }
  return value;
}

function storageRoot(ownerId: string, presentationId: string) {
  return `${ownerId}/presentations/${presentationId}`;
}

function htmlStorageKey(ownerId: string, presentationId: string) {
  return `${storageRoot(ownerId, presentationId)}/index.html`;
}

/**
 * New presentations persist one content artifact only. Dashi's editor shell,
 * theme runtimes and controls are immutable application assets mounted when
 * the HTML is opened; they are not copied into every teacher-owned artifact.
 * Version-1/2 bundle reads remain solely for already stored presentations.
 */
export class PresentationArtifactStorage {
  constructor(private readonly storage: ObjectStorage | null) {}

  get configured() {
    return Boolean(this.storage);
  }

  keyFor(ownerId: string, presentationId: string) {
    return htmlStorageKey(ownerId, presentationId);
  }

  async save(ownerId: string, presentationId: string, bundle: NativeDashiBundle) {
    if (!this.storage) throw new Error("presentation_storage_not_configured");
    const root = storageRoot(ownerId, presentationId);
    const html = bundle.files.find((file) => file.path === "index.html");
    if (!html) throw new Error("presentation_storage_html_missing");
    const storageKey = htmlStorageKey(ownerId, presentationId);
    await this.storage.put(storageKey, html.body, { contentType: "text/html; charset=utf-8" });
    // Remove old per-deck manifests, JSON and copied runtimes only after the
    // single HTML object is committed successfully.
    const obsolete = (await this.objectPaths(root)).filter((path) => path !== storageKey);
    if (obsolete.length) await this.storage.remove(obsolete);
    return { storageKey, byteSize: html.body.byteLength };
  }

  /** Stage a unique immutable revision; never touch the currently published object. */
  async saveRevision(ownerId: string, presentationId: string, bundle: NativeDashiBundle) {
    if (!this.storage) throw new Error("presentation_storage_not_configured");
    const html = bundle.files.find((file) => file.path === "index.html");
    if (!html) throw new Error("presentation_storage_html_missing");
    const storageKey = `${storageRoot(ownerId, presentationId)}/revisions/${crypto.randomUUID()}.html`;
    await this.storage.put(storageKey, html.body, { contentType: "text/html; charset=utf-8" });
    return { storageKey, byteSize: html.body.byteLength };
  }

  async load(ownerId: string, presentationId: string, storageKey = storageRoot(ownerId, presentationId)): Promise<NativeDashiBundle> {
    if (!this.storage) throw new Error("presentation_storage_not_configured");
    if (storageKey.endsWith(".html")) {
      const html = await this.storage.get(storageKey);
      if (!html) throw new Error("presentation_storage_bundle_missing");
      return {
        files: [{ path: "index.html", body: html.body }],
        byteSize: html.body.byteLength,
      };
    }
    const manifestFile = await this.storage.get(`${storageKey}/${manifestName}`);
    if (!manifestFile) throw new Error("presentation_storage_bundle_missing");
    const manifest = JSON.parse(new TextDecoder().decode(manifestFile.body)) as StoredManifest;
    if ((manifest.version !== 1 && manifest.version !== 2) || !Array.isArray(manifest.files)) {
      throw new Error("presentation_storage_manifest_invalid");
    }
    const files = await Promise.all(manifest.files.map(async (entry) => {
      const relative = assertRelativePath(entry.path);
      const objectKey = manifest.version === 2 && entry.scope === "runtime"
        ? manifest.runtimeKey ? `${manifest.runtimeKey}/${relative}` : null
        : `${storageKey}/${relative}`;
      if (!objectKey) throw new Error("presentation_storage_manifest_invalid");
      const result = await this.storage!.get(objectKey);
      if (!result) throw new Error("presentation_storage_bundle_incomplete");
      const body = result.body;
      if (body.byteLength !== entry.bytes || createHash("sha256").update(body).digest("hex") !== entry.sha256) {
        throw new Error("presentation_storage_bundle_corrupt");
      }
      return { path: relative, body };
    }));
    if (!files.some((file) => file.path === "index.html")) throw new Error("presentation_storage_manifest_invalid");
    return { files, byteSize: manifest.byteSize };
  }

  async remove(ownerId: string, presentationId: string, storageKey = storageRoot(ownerId, presentationId)) {
    if (!this.storage) return;
    if (storageKey.endsWith(".html")) {
      await this.storage.remove([storageKey]);
      return;
    }
    const paths = await this.objectPaths(storageKey);
    if (!paths.length) return;
    await this.storage.remove(paths);
  }

  private async objectPaths(root: string): Promise<string[]> {
    return (await this.storage!.list(root)).map((object) => object.key);
  }
}
