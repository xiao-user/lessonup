import { createClient } from "@supabase/supabase-js";
import type { Context, Next } from "hono";
import { config, hasSupabase } from "./config.js";

export type AppBindings = {
  Variables: { userId: string };
};

const devUserId = "00000000-0000-4000-8000-000000000001";
const authClient = hasSupabase
  ? createClient(config.SUPABASE_URL!, config.SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

export async function requireUser(c: Context<AppBindings>, next: Next) {
  const authorization = c.req.header("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (token && authClient) {
    const { data, error } = await authClient.auth.getUser(token);
    if (!error && data.user) {
      c.set("userId", data.user.id);
      return next();
    }
  }

  if (config.NODE_ENV === "test" && config.LESSONUP_DEV_AUTH === "1") {
    c.set("userId", c.req.header("x-lessonup-user") ?? devUserId);
    return next();
  }
  return c.json({ error: "authentication_required" }, 401);
}
