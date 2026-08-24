import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

const key = createHash("sha256")
  .update(config.AGENT_STATE_ENCRYPTION_KEY ?? "lessonup-development-run-state-key")
  .digest();

export function encryptRunState(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}
