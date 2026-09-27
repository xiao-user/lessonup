/**
 * Provider-neutral private object storage. Application services deal only in
 * immutable object keys and byte streams; ACLs remain a service concern and
 * never depend on a storage vendor's bucket policy language.
 */
export type ObjectMetadata = {
  key: string;
  size: number;
  contentType: string | null;
  etag: string | null;
  uploadedAt: string | null;
  customMetadata: Record<string, string>;
};

export type StoredObject = ObjectMetadata & { body: Uint8Array };

export interface ObjectStorage {
  put(key: string, body: Blob | Uint8Array | ArrayBuffer, options?: {
    contentType?: string;
    customMetadata?: Record<string, string>;
  }): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  list(prefix: string): Promise<ObjectMetadata[]>;
  remove(keys: string[]): Promise<void>;
}

/** Test-only implementation that also documents the storage contract. */
export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, StoredObject>();

  async put(key: string, body: Blob | Uint8Array | ArrayBuffer, options: {
    contentType?: string;
    customMetadata?: Record<string, string>;
  } = {}) {
    const bytes = body instanceof Blob
      ? new Uint8Array(await body.arrayBuffer())
      : body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(body);
    this.objects.set(key, {
      key,
      body: bytes,
      size: bytes.byteLength,
      contentType: options.contentType ?? null,
      etag: null,
      uploadedAt: new Date().toISOString(),
      customMetadata: { ...(options.customMetadata ?? {}) },
    });
  }

  async get(key: string) {
    const value = this.objects.get(key);
    return value ? { ...value, body: new Uint8Array(value.body), customMetadata: { ...value.customMetadata } } : null;
  }

  async list(prefix: string) {
    return [...this.objects.values()]
      .filter((object) => object.key.startsWith(prefix))
      .map(({ body: _body, ...object }) => ({ ...object, customMetadata: { ...object.customMetadata } }));
  }

  async remove(keys: string[]) {
    for (const key of keys) this.objects.delete(key);
  }
}
