import { describe, expect, it } from "vitest";

import {
  toolActivityStateForOutcome,
  toolCompletionLabelForOutcome,
  toolCompletionOutcomeOf,
} from "./tool-completion-outcome.js";

describe("toolCompletionOutcomeOf", () => {
  it("keeps successful tools completed", () => {
    expect(toolCompletionOutcomeOf({ ok: true })).toBe("completed");
  });

  it("treats no-effect proposals as no_change rather than failure", () => {
    expect(toolCompletionOutcomeOf({
      ok: false,
      revisionCode: "no_effect_patch",
    })).toBe("no_change");
    expect(toolActivityStateForOutcome("no_change")).toBe("unchanged");
    expect(toolCompletionLabelForOutcome("准备修改建议", "no_change"))
      .toBe("现稿已符合要求，将复用当前内容");
  });

  it("keeps recoverable proposal revisions distinct from hard failures", () => {
    expect(toolCompletionOutcomeOf({
      ok: false,
      revisionCode: "semantic_quality_rejected",
    })).toBe("needs_revision");
    expect(toolActivityStateForOutcome("needs_revision")).toBe("needs_revision");
    expect(toolCompletionLabelForOutcome("准备修改建议", "needs_revision"))
      .toBe("准备修改建议");
    expect(toolCompletionOutcomeOf({ ok: false })).toBe("failed");
  });
});
