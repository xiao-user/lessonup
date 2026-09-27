import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IceCreamHarness from "../../components/site/IceCreamHarness.js";
import { activeApprovalFrom } from "./agent-run-control.js";

const base = { id: "approval", runId: "run", assistantMessageId: "assistant", state: "approved", continuationStatus: "ready",
  patch: { summary: "课堂演示方案", kind: "presentation_storyboard", goal: { goal: "观察与写作", themePack: "theme09", slides: [] } } };
function render(approval: any) {
  const active = activeApprovalFrom([approval]);
  return renderToStaticMarkup(React.createElement(IceCreamHarness, {
    chat: { approvals: [approval], approval: active, runtime: { agent: true }, draft: "", uploads: [], queuedInputs: [],
      status: active ? "awaiting_approval" : "ready", activities: [], sources: [] },
    messages: [], statusText: {}, emptyTitle: "", emptyDescription: "",
  } as any));
}

describe("approval controls in the production harness", () => {
  it("offers reply recovery for a delivered presentation", () => {
    const html = render({ ...base, delivery: { status: "ready", presentationId: "deck" } });
    expect(html).toContain("恢复回复");
    expect(html).toContain("演示已保存");
    expect(html).not.toContain("恢复生成");
  });
  it("offers only read synchronization for an ambiguous request", () => {
    const html = render({ ...base, state: "pending", transport: "unknown" });
    expect(html).toContain("重新同步");
    expect(html).not.toContain("确认并生成");
    expect(html).not.toContain("恢复生成");
  });
  it("does not offer to generate after a rejection", () => {
    const html = render({ ...base, state: "rejected" });
    expect(html).toContain("拒绝决定");
    expect(html).toContain("恢复回复");
    expect(html).not.toContain("恢复生成");
  });
  it("removes action controls after completion", () => {
    const html = render({ ...base, continuationStatus: "completed" });
    expect(html).not.toContain("恢复生成");
    expect(html).not.toContain("恢复回复");
    expect(html).not.toContain("确认并生成");
  });
});
