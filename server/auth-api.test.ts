import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { MemoryLessonRepository } from "./repositories/memory-repository.js";
import type { SessionAuthentication } from "./platform/session-authentication.js";

const account = {
  id: "00000000-0000-4000-8000-00000000000a",
  loginName: "teacher",
  createdAt: "2026-08-24T00:00:00.000Z",
};

function createAuthentication(): SessionAuthentication {
  return {
    userIdForAccessToken: async (token) => token === "valid-token" ? account.id : null,
    accountForAccessToken: async (token) => token === "valid-token" ? account : null,
    signIn: async (loginName, password) => (
      loginName === "teacher" && password === "correct-password"
        ? { accessToken: "valid-token", expiresAt: "2026-09-24T00:00:00.000Z", account }
        : null
    ),
    signOut: vi.fn(async () => undefined),
  };
}

describe("application session API", () => {
  it("uses the provider-neutral authentication port for sign-in, profile, sign-out, and API scope", async () => {
    const authentication = createAuthentication();
    const app = createApp(new MemoryLessonRepository(), { agent: null, authentication });

    const invalid = await app.request("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: "teacher", password: "incorrect" }),
    });
    expect(invalid.status).toBe(401);

    const signIn = await app.request("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: "teacher", password: "correct-password" }),
    });
    expect(signIn.status).toBe(200);
    await expect(signIn.json()).resolves.toMatchObject({ accessToken: "valid-token", account });

    const me = await app.request("/api/auth/me", { headers: { authorization: "Bearer valid-token" } });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toEqual(account);

    const notebooks = await app.request("/api/notebooks", { headers: { authorization: "Bearer valid-token" } });
    expect(notebooks.status).toBe(200);
    const unauthenticated = await app.request("/api/notebooks");
    expect(unauthenticated.status).toBe(401);

    const signOut = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(signOut.status).toBe(204);
    expect(authentication.signOut).toHaveBeenCalledWith("valid-token");
  });
});
