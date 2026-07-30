import type { AgentInputItem } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";
import { RepositorySession } from "../repository.js";
import {
  selectProtocolSafeSessionHistory,
  threadMemorySummaryItem,
  withoutThreadMemorySummaryItems,
} from "./session-history.js";

const call = (id: string) => ({
  type: "function_call", callId: id, name: "read_section", arguments: "{}",
}) as AgentInputItem;
const result = (id: string) => ({
  type: "function_call_result", callId: id, name: "read_section",
  output: { type: "text", text: "ok" }, status: "completed",
}) as AgentInputItem;
const message = (content: string) => ({ role: "user", type: "message", content }) as AgentInputItem;

describe("selectProtocolSafeSessionHistory", () => {
  it("never splits a parallel function-call round at the recent-item boundary", () => {
    const ids = Array.from({ length: 11 }, (_, index) => `call_${index}`);
    const history = [
      message("older"),
      ...ids.map(call),
      ...ids.map(result),
      message("latest-1"),
      message("latest-2"),
      message("latest-3"),
    ];

    const selected = selectProtocolSafeSessionHistory({
      history,
      current: [message("current")],
      keepRecentItems: 24,
    });
    const selectedCallIds = selected.filter((item) => (item as any).type === "function_call")
      .map((item) => (item as any).callId);
    const selectedResultIds = selected.filter((item) => (item as any).type === "function_call_result")
      .map((item) => (item as any).callId);

    expect(selectedCallIds).toEqual(selectedResultIds);
    expect(selected).toEqual(history.slice(-3));
  });

  it("drops incomplete calls and orphan results instead of replaying invalid protocol history", () => {
    const selected = selectProtocolSafeSessionHistory({
      history: [call("complete"), call("missing"), result("complete"), result("orphan"), message("latest")],
      current: [message("current")],
    });

    expect(selected).toEqual([call("complete"), result("complete"), message("latest")]);
  });

  it("removes previously persisted structured summaries from raw history", () => {
    expect(withoutThreadMemorySummaryItems([
      message("keep"), threadMemorySummaryItem("old summary"),
    ])).toEqual([message("keep")]);
  });
});

describe("RepositorySession", () => {
  it("does not persist the transient structured summary injected for model input", async () => {
    const repository = { addSessionItems: vi.fn().mockResolvedValue(undefined) } as any;
    const session = new RepositorySession(repository, "owner", "thread", "branch");
    const durable = message("current");

    await session.addItems([threadMemorySummaryItem("summary"), durable]);

    expect(repository.addSessionItems).toHaveBeenCalledWith("owner", "thread", "branch", [durable]);
  });
});
