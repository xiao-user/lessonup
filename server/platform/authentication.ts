/** Provider-neutral authentication boundary used by HTTP middleware. */
export interface AccessTokenAuthenticator {
  userIdForAccessToken(token: string): Promise<string | null>;
}
