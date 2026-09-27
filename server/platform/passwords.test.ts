import { describe, expect, it } from "vitest";
import { digestAccessToken, hashPassword, verifyPassword } from "./passwords.js";

describe("password primitives", () => {
  it("verifies the original password only", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(verifyPassword("correct-horse-battery-staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("incorrect", hash)).resolves.toBe(false);
  });

  it("creates stable, one-way token digests", async () => {
    await expect(digestAccessToken("token")).resolves.toBe(await digestAccessToken("token"));
    await expect(digestAccessToken("token")).resolves.not.toBe(await digestAccessToken("other-token"));
  });
});
