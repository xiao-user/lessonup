const storageKey = "lessonup.session.v1";

function readStoredSession() {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const session = JSON.parse(raw);
    return typeof session?.accessToken === "string" && typeof session?.expiresAt === "string" ? session : null;
  } catch {
    return null;
  }
}

function writeStoredSession(session) {
  if (session) window.localStorage.setItem(storageKey, JSON.stringify(session));
  else window.localStorage.removeItem(storageKey);
  window.dispatchEvent(new Event("lessonup-session-change"));
}

async function authRequest(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `request_failed:${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

export async function getAccessToken() {
  const session = readStoredSession();
  if (!session || Date.parse(session.expiresAt) <= Date.now()) {
    if (session) writeStoredSession(null);
    return null;
  }
  return session.accessToken;
}

export async function restoreSession() {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;
  try {
    const account = await authRequest("/api/auth/me", { headers: { authorization: `Bearer ${accessToken}` } });
    return { ...readStoredSession(), account };
  } catch {
    writeStoredSession(null);
    return null;
  }
}

export async function signIn(loginName, password) {
  const session = await authRequest("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName, password }),
  });
  writeStoredSession(session);
  return session;
}

export async function signOut() {
  const accessToken = await getAccessToken();
  try {
    if (accessToken) await authRequest("/api/auth/sign-out", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } finally {
    writeStoredSession(null);
  }
}

export async function getCurrentAccount() {
  const session = await restoreSession();
  return session?.account ?? null;
}
