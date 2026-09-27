import { createOpaqueToken, digestAccessToken, verifyPassword } from "./passwords.js";
import type { SqlDatabase } from "./sql-database.js";
import type { IssuedSession, PublicAccount, SessionAuthentication } from "./session-authentication.js";

type UserRow = { id: string; login_name: string; password_hash: string; created_at: string };
type SessionRow = { user_id: string };

/**
 * D1 identity implementation. It owns password checks and opaque-session
 * issuance; callers only receive the token and never D1 or SQL details.
 */
export class D1SessionAuthenticator implements SessionAuthentication {
  constructor(
    private readonly database: SqlDatabase,
    private readonly sessionLifetimeMs = 30 * 24 * 60 * 60 * 1_000,
  ) {}

  async userIdForAccessToken(token: string) {
    const result = await this.database.query<SessionRow>({
      sql: `SELECT user_id
            FROM auth_sessions
            WHERE token_hash = ?
              AND revoked_at IS NULL
              AND expires_at > ?`,
      params: [await digestAccessToken(token), new Date().toISOString()],
    });
    return result.rows[0]?.user_id ?? null;
  }

  async signIn(loginName: string, password: string): Promise<IssuedSession | null> {
    const normalizedLogin = loginName.trim().toLowerCase();
    if (!normalizedLogin || !password) return null;
    const users = await this.database.query<UserRow>({
      sql: "SELECT id, login_name, password_hash, created_at FROM users WHERE login_name = ?",
      params: [normalizedLogin],
    });
    const user = users.rows[0];
    if (!user || !await verifyPassword(password, user.password_hash)) return null;
    return this.issue(user);
  }

  async signOut(accessToken: string) {
    await this.database.query({
      sql: "UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      params: [new Date().toISOString(), await digestAccessToken(accessToken)],
    });
  }

  async accountForAccessToken(accessToken: string): Promise<PublicAccount | null> {
    const userId = await this.userIdForAccessToken(accessToken);
    if (!userId) return null;
    const result = await this.database.query<Pick<UserRow, "id" | "login_name" | "created_at">>({
      sql: "SELECT id, login_name, created_at FROM users WHERE id = ?",
      params: [userId],
    });
    const user = result.rows[0];
    return user ? toPublicAccount(user) : null;
  }

  private async issue(user: UserRow): Promise<IssuedSession> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionLifetimeMs).toISOString();
    const accessToken = createOpaqueToken();
    await this.database.query({
      sql: `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, NULL)`,
      params: [crypto.randomUUID(), user.id, await digestAccessToken(accessToken), expiresAt, now.toISOString()],
    });
    return { accessToken, expiresAt, account: toPublicAccount(user) };
  }
}

function toPublicAccount(user: Pick<UserRow, "id" | "login_name" | "created_at">): PublicAccount {
  return { id: user.id, loginName: user.login_name, createdAt: user.created_at };
}
