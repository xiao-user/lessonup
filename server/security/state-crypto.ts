import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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

export function decryptRunState(value: string) {
  const [ivValue, tagValue, dataValue] = value.split(".");
  if (!ivValue || !tagValue || !dataValue) throw new Error("invalid_run_state");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
