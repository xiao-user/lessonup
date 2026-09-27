import type { ObjectMetadata, ObjectStorage, StoredObject } from "./object-storage.js";

type R2ObjectLike = {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

type R2ObjectBodyLike = R2ObjectLike & { arrayBuffer(): Promise<ArrayBuffer> };

/** The narrow part of Cloudflare's R2 binding used by this adapter. */
export type R2BucketBinding = {
  put(key: string, body: Blob | Uint8Array | ArrayBuffer, options?: {
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
  }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: R2ObjectLike[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string[]): Promise<void>;
};

/**
 * The only application adapter aware of Cloudflare's R2 binding. R2 is
 * S3-compatible, so a future COS/OSS/S3 implementation only replaces this
 * file and its composition root registration.
 */
export class R2ObjectStorage implements ObjectStorage {
  constructor(private readonly bucket: R2BucketBinding) {}

  async put(key: string, body: Blob | Uint8Array | ArrayBuffer, options: {
    contentType?: string;
    customMetadata?: Record<string, string>;
  } = {}) {
    await this.bucket.put(key, body, {
      httpMetadata: options.contentType ? { contentType: options.contentType } : undefined,
      customMetadata: options.customMetadata,
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    const body = new Uint8Array(await object.arrayBuffer());
    return {
      ...this.metadata(key, object),
      body,
    };
  }

  async list(prefix: string): Promise<ObjectMetadata[]> {
    const objects: ObjectMetadata[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor });
      objects.push(...page.objects.map((object) => this.metadata(object.key, object)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return objects;
  }

  async remove(keys: string[]) {
    // R2 deletes at most 1,000 keys per request. Keep this platform detail
    // here so callers retain a portable all-or-nothing-looking API.
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      await this.bucket.delete(keys.slice(offset, offset + 1_000));
    }
  }

  private metadata(key: string, object: Pick<R2ObjectLike, "size" | "etag" | "uploaded" | "httpMetadata" | "customMetadata">): ObjectMetadata {
    return {
      key,
      size: object.size,
      contentType: object.httpMetadata?.contentType ?? null,
      etag: object.etag ?? null,
      uploadedAt: object.uploaded?.toISOString() ?? null,
      customMetadata: { ...(object.customMetadata ?? {}) },
    };
  }
}
