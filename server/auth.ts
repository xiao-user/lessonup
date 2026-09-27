import type { Context, Next } from "hono";
import { config } from "./config.js";
import type { AccessTokenAuthenticator } from "./platform/authentication.js";
import { D1SessionAuthenticator } from "./platform/d1-session-authenticator.js";
import type { SessionAuthentication } from "./platform/session-authentication.js";
import type { SqlDatabase } from "./platform/sql-database.js";

export type AppBindings = {
  Variables: { userId: string };
};

const devUserId = "00000000-0000-4000-8000-000000000001";
export function createRequireUser(authenticator: AccessTokenAuthenticator | null = null) {
  return async function requireUser(c: Context<AppBindings>, next: Next) {
    const authorization = c.req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (token && authenticator) {
      const userId = await authenticator.userIdForAccessToken(token);
      if (userId) {
        c.set("userId", userId);
        return next();
      }
    }

    if (!authenticator && config.NODE_ENV === "test" && config.LESSONUP_DEV_AUTH === "1") {
      c.set("userId", c.req.header("x-lessonup-user") ?? devUserId);
      return next();
    }
    return c.json({ error: "authentication_required" }, 401);
  };
}

export function getRuntimeAuthentication(database?: SqlDatabase): SessionAuthentication | null {
  if (database) return new D1SessionAuthenticator(database);
  return null;
}

export const requireUser = createRequireUser();
