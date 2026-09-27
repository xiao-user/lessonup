const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array) => [...bytes]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");

const fromHex = (value: string) => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error("password_hash_invalid");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

// Cloudflare Workers currently caps PBKDF2 at 100,000 iterations. Keep the
// stored format portable instead of falling back to a Node-only password API.
const iterations = 100_000;
const hashName = "SHA-256";

async function derive(password: string, salt: Uint8Array, workFactor = iterations) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  // A copied ArrayBuffer is accepted by both Node's WebCrypto typings and the
  // Workers runtime without depending on Node's Buffer implementation.
  const saltBuffer = salt.slice().buffer as ArrayBuffer;
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: hashName, salt: saltBuffer, iterations: workFactor }, material, 256);
  return new Uint8Array(bits);
}

/** A portable PHC-like string that can be verified in Workers, Node, or a future API host. */
export async function hashPassword(password: string) {
  if (password.length < 12) throw new Error("password_too_short");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await derive(password, salt);
  return `pbkdf2-${hashName.toLowerCase()}$${iterations}$${toHex(salt)}$${toHex(digest)}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, iterationValue, saltValue, digestValue] = encoded.split("$");
  const storedIterations = Number(iterationValue);
  if (
    algorithm !== `pbkdf2-${hashName.toLowerCase()}`
    || !Number.isInteger(storedIterations)
    || storedIterations < 10_000
    || storedIterations > iterations
    || !saltValue
    || !digestValue
  ) {
    return false;
  }
  const expected = fromHex(digestValue);
  const actual = await derive(password, fromHex(saltValue), storedIterations);
  if (actual.byteLength !== expected.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < actual.byteLength; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

export async function digestAccessToken(token: string) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
}

export function createOpaqueToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
