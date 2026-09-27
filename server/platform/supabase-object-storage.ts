import type { SupabaseClient } from "@supabase/supabase-js";
import type { ObjectMetadata, ObjectStorage, StoredObject } from "./object-storage.js";

/**
 * Transitional adapter used only while importing existing Supabase objects.
 * Application services must depend on ObjectStorage, not this adapter.
 */
export class SupabaseObjectStorage implements ObjectStorage {
  constructor(
    private readonly client: SupabaseClient,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: Blob | Uint8Array | ArrayBuffer, options: {
    contentType?: string;
    customMetadata?: Record<string, string>;
  } = {}) {
    const uploaded = await this.client.storage.from(this.bucket).upload(key, body, {
      upsert: true,
      contentType: options.contentType,
      metadata: options.customMetadata,
    });
    if (uploaded.error) throw new Error(`object_storage_put_failed:${uploaded.error.message}`);
  }

  async get(key: string): Promise<StoredObject | null> {
    const downloaded = await this.client.storage.from(this.bucket).download(key);
    if (downloaded.error) {
      if (downloaded.error.statusCode === "404") return null;
      throw new Error(`object_storage_get_failed:${downloaded.error.message}`);
    }
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    return {
      key,
      body: bytes,
      size: bytes.byteLength,
      contentType: downloaded.data.type || null,
      etag: null,
      uploadedAt: null,
      customMetadata: {},
    };
  }

  async list(prefix: string): Promise<ObjectMetadata[]> {
    const objects: ObjectMetadata[] = [];
    const visit = async (path: string) => {
      const listed = await this.client.storage.from(this.bucket).list(path, { limit: 1_000 });
      if (listed.error) throw new Error(`object_storage_list_failed:${listed.error.message}`);
      for (const entry of listed.data) {
        const key = `${path}/${entry.name}`;
        if (entry.id === null) await visit(key);
        else {
          objects.push({
            key,
            size: Number(entry.metadata?.size ?? 0),
            contentType: typeof entry.metadata?.mimetype === "string" ? entry.metadata.mimetype : null,
            etag: typeof entry.metadata?.eTag === "string" ? entry.metadata.eTag : null,
            uploadedAt: entry.updated_at ?? entry.created_at ?? null,
            customMetadata: {},
          });
        }
      }
    };
    await visit(prefix);
    return objects;
  }

  async remove(keys: string[]) {
    if (!keys.length) return;
    const removed = await this.client.storage.from(this.bucket).remove(keys);
    if (removed.error) throw new Error(`object_storage_remove_failed:${removed.error.message}`);
  }
}
