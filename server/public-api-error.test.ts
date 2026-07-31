import { describe, expect, it } from "vitest";
import { z } from "zod";
import { publicApiError } from "./public-api-error.js";

describe("publicApiError", () => {
  it("keeps stable product errors", () => {
    expect(publicApiError(new Error("lesson_file_not_found"))).toEqual({
      code: "lesson_file_not_found",
      status: 404,
    });
    expect(publicApiError(new Error("stale_document"))).toEqual({
      code: "stale_document",
      status: 409,
    });
  });

  it("does not expose provider or database errors", () => {
    expect(publicApiError(new Error("duplicate key value violates unique constraint users_email_key")))
      .toEqual({ code: "internal_error", status: 500 });
  });

  it("normalizes validation failures", () => {
    const result = z.object({ id: z.string().uuid() }).safeParse({ id: "bad" });
    if (result.success) throw new Error("expected_validation_failure");
    expect(publicApiError(result.error)).toEqual({ code: "invalid_request", status: 400 });
  });
});
