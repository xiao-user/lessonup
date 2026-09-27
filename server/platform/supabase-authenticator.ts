import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AccessTokenAuthenticator } from "./authentication.js";

/** Transitional implementation retained only until the D1 session store is live. */
export class SupabaseAccessTokenAuthenticator implements AccessTokenAuthenticator {
  private readonly client: SupabaseClient;

  constructor(url: string, anonKey: string) {
    this.client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async userIdForAccessToken(token: string) {
    const { data, error } = await this.client.auth.getUser(token);
    return !error && data.user ? data.user.id : null;
  }
}
