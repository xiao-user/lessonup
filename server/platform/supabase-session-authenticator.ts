import { createClient } from "@supabase/supabase-js";
import type { PublicAccount, SessionAuthentication } from "./session-authentication.js";

/** Transitional adapter: keeps legacy Supabase deployments working while the
 * application-facing authentication contract remains provider-neutral. */
export class SupabaseSessionAuthenticator implements SessionAuthentication {
  private readonly client;

  constructor(url: string, anonymousKey: string) {
    this.client = createClient(url, anonymousKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async userIdForAccessToken(accessToken: string) {
    const account = await this.accountForAccessToken(accessToken);
    return account?.id ?? null;
  }

  async signIn(loginName: string, password: string) {
    const normalizedLogin = loginName.trim().toLowerCase();
    if (!normalizedLogin || !password) return null;
    const email = normalizedLogin.includes("@") ? normalizedLogin : `${normalizedLogin}@lessonup.local`;
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error || !data.session || !data.user) return null;
    return {
      accessToken: data.session.access_token,
      expiresAt: new Date((data.session.expires_at ?? Math.floor(Date.now() / 1_000) + 3_600) * 1_000).toISOString(),
      account: toPublicAccount(data.user),
    };
  }

  async signOut(accessToken: string) {
    const { error } = await this.client.auth.signOut({ scope: "local" });
    // Supabase's anonymous client does not have the caller's persisted
    // session. A revoked access token will still be rejected by getUser, so
    // clear the browser copy even if the optional server-side revoke fails.
    if (error && accessToken) return;
  }

  async accountForAccessToken(accessToken: string): Promise<PublicAccount | null> {
    const { data, error } = await this.client.auth.getUser(accessToken);
    return error || !data.user ? null : toPublicAccount(data.user);
  }
}

function toPublicAccount(user: { id: string; email?: string; created_at?: string }) {
  return {
    id: user.id,
    loginName: user.email?.split("@")[0] ?? user.id,
    createdAt: user.created_at ?? new Date(0).toISOString(),
  };
}
