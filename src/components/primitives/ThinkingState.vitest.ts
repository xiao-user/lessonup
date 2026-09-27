import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ThinkingState from "./ThinkingState.js";

describe("ThinkingState", () => {
  it("uses the Beautiful UI sparkle header instead of the pixel-grid loader", () => {
    const markup = renderToStaticMarkup(React.createElement(ThinkingState, { label: "正在思考" }));

    expect(markup).toContain("正在思考");
    expect(markup).toContain("M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z");
    expect(markup).toContain("shimmer-text");
    expect(markup).not.toContain("pixel-on");
  });
});
