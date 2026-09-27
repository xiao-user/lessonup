import type { AccessTokenAuthenticator } from "./authentication.js";

export type PublicAccount = {
  id: string;
  loginName: string;
  createdAt: string;
};

export type IssuedSession = {
  accessToken: string;
  expiresAt: string;
  account: PublicAccount;
};

/**
 * Application-level password/session port. HTTP handlers and the browser know
 * this contract, not D1, Supabase, cookie formats, or provider SDKs.
 */
export interface SessionAuthentication extends AccessTokenAuthenticator {
  signIn(loginName: string, password: string): Promise<IssuedSession | null>;
  signOut(accessToken: string): Promise<void>;
  accountForAccessToken(accessToken: string): Promise<PublicAccount | null>;
}
