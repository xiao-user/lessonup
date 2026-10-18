// JSON can escape one UTF-16 code unit to six bytes. Two 200k selection
// strings plus a 20k message fit below 3 MiB even in that worst case.
export const MAX_AGENT_REQUEST_BYTES = 3 * 1024 * 1024;

export class AgentRequestBodyError extends Error {
  constructor(readonly code: "agent_request_too_large" | "agent_request_body_unavailable", readonly status: 400 | 413) {
    super(code);
  }
}

/** Own the bytes before a Request crosses a Worker/DO boundary. No tee/clone. */
export async function ownAgentRequest(request: Request) {
  if (request.method === "GET" || request.method === "HEAD") return { request, json: null };
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_AGENT_REQUEST_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new AgentRequestBodyError("agent_request_too_large", 413);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof AgentRequestBodyError) throw error;
      await reader.cancel().catch(() => undefined);
      throw new AgentRequestBodyError("agent_request_body_unavailable", 400);
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const owned = new Request(request, { headers, body: size ? bytes : null });
  let json: unknown = null;
  if (size) { try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* Route owns JSON validation. */ } }
  return { request: owned, json };
}
