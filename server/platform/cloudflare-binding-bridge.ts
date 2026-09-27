import type { ObjectMetadata, ObjectStorage, StoredObject } from "./object-storage.js";
import type { SqlDatabase, SqlResult, SqlStatement, SqlValue } from "./sql-database.js";

const databaseOrigin = "http://lessonup.d1";
const objectOrigin = "http://lessonup.r2";

type BridgeFetch = typeof fetch;

type BridgeSqlResult = {
  rows: Record<string, unknown>[];
  rowsAffected: number;
};

/**
 * Adapters used only by the Node process inside a Cloudflare Container.
 *
 * `lessonup.d1` and `lessonup.r2` are virtual hosts intercepted by the
 * Worker. They are never public endpoints: the Container outbound handler
 * resolves them straight to the Worker bindings. Keeping this HTTP hop here
 * lets the rest of the server retain the provider-neutral SqlDatabase and
 * ObjectStorage ports.
 */
export class CloudflareBindingSqlDatabase implements SqlDatabase {
  constructor(private readonly request: BridgeFetch = fetch) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(statement: SqlStatement): Promise<SqlResult<Row>> {
    const response = await this.request(`${databaseOrigin}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: statement.sql, params: statement.params ?? [] }),
    });
    return this.readResult<Row>(response);
  }

  async batch<Row extends Record<string, unknown> = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlResult<Row>[]> {
    if (!statements.length) return [];
    const response = await this.request(`${databaseOrigin}/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statements }),
    });
    if (!response.ok) throw new Error(`cloudflare_d1_bridge_${response.status}`);
    return await response.json() as SqlResult<Row>[];
  }

  private async readResult<Row extends Record<string, unknown>>(response: Response): Promise<SqlResult<Row>> {
    if (!response.ok) throw new Error(`cloudflare_d1_bridge_${response.status}`);
    return await response.json() as BridgeSqlResult as SqlResult<Row>;
  }
}

export class CloudflareBindingObjectStorage implements ObjectStorage {
  constructor(private readonly request: BridgeFetch = fetch) {}

  async put(key: string, body: Blob | Uint8Array | ArrayBuffer, options: {
    contentType?: string;
    customMetadata?: Record<string, string>;
  } = {}) {
    const response = await this.request(this.objectUrl(key), {
      method: "PUT",
      headers: this.writeHeaders(options),
      // Node's DOM declarations disagree with its runtime here for Uint8Array
      // backed by a SharedArrayBuffer. Fetch accepts it as a request body.
      body: body as unknown as BodyInit,
    });
    if (!response.ok) throw new Error(`cloudflare_r2_bridge_${response.status}`);
  }

  async get(key: string): Promise<StoredObject | null> {
    const response = await this.request(this.objectUrl(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`cloudflare_r2_bridge_${response.status}`);
    return {
      key,
      size: Number(response.headers.get("x-lessonup-size") ?? 0),
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      uploadedAt: response.headers.get("last-modified"),
      customMetadata: parseMetadata(response.headers.get("x-lessonup-metadata")),
      body: new Uint8Array(await response.arrayBuffer()),
    };
  }

  async list(prefix: string): Promise<ObjectMetadata[]> {
    const objects: ObjectMetadata[] = [];
    let cursor: string | undefined;
    do {
      const url = new URL(`${objectOrigin}/objects`);
      url.searchParams.set("prefix", prefix);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await this.request(url);
      if (!response.ok) throw new Error(`cloudflare_r2_bridge_${response.status}`);
      const page = await response.json() as { objects: ObjectMetadata[]; cursor?: string };
      objects.push(...page.objects);
      cursor = page.cursor;
    } while (cursor);
    return objects;
  }

  async remove(keys: string[]) {
    if (!keys.length) return;
    const response = await this.request(`${objectOrigin}/objects`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys }),
    });
    if (!response.ok) throw new Error(`cloudflare_r2_bridge_${response.status}`);
  }

  private objectUrl(key: string) {
    return `${objectOrigin}/objects/${encodeURIComponent(key)}`;
  }

  private writeHeaders(options: { contentType?: string; customMetadata?: Record<string, string> }) {
    const headers = new Headers();
    if (options.contentType) headers.set("content-type", options.contentType);
    if (options.customMetadata && Object.keys(options.customMetadata).length) {
      headers.set("x-lessonup-metadata", encodeURIComponent(JSON.stringify(options.customMetadata)));
    }
    return headers;
  }
}

function parseMetadata(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const metadata: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item === "string") metadata[key] = item;
    }
    return metadata;
  } catch {
    return {};
  }
}

export function isBridgeSqlValue(value: unknown): value is SqlValue {
  return value === null || typeof value === "string" || typeof value === "number";
}
