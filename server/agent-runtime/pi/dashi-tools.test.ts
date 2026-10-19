import { describe, expect, it, vi } from "vitest";
import { safeDashiPlanningError } from "../../presentations/dashi-planning-errors.js";
import { createPiDashiPlanningSession } from "./dashi-tools.js";

const outputOf = (result: { content: unknown[] }) => JSON.parse((result.content[0] as { text: string }).text);

describe("Pi Dashi planning session", () => {
  it("binds the confirmed theme and accepts natural classroom intents", async () => {
    let active = 0;
    let maximumActive = 0;
    const calls: Array<{ role: string; keyword?: string }> = [];
    const dashi = {
      queryLayouts: async ({ role, keyword }: { role: string; keyword?: string }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        calls.push({ role, keyword });
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return {
          layouts: [{
            layout: `theme09_page${String(calls.length).padStart(3, "0")}`,
            label: "候选",
            roles: [role],
            copyKeys: ["title"],
            arrayMeta: [],
            controls: [{ key: "showTitle", type: "toggle", default: true }],
          }],
        };
      },
      inspectLayouts: async () => ({ layouts: [] }),
    };
    const session = createPiDashiPlanningSession(dashi as never, { theme: "theme09", seed: "run" });
    const query = session.tools.find((tool) => tool.name === "query_dashi_layouts")!;
    const input = {
      queries: [
        { intent: "课题与核心问题导入" },
        { intent: "拟人与拟物对照辨析" },
        { intent: "片段写作任务" },
      ],
    };
    const progress: unknown[] = [];

    const first = await query.execute(
      "call-1",
      input,
      new AbortController().signal,
      (update) => progress.push(update.details),
    );
    expect(calls).toEqual([
      { role: "cover", keyword: "课题与核心问题导入" },
      { role: "comparison", keyword: "拟人与拟物对照辨析" },
      { role: "actions", keyword: "片段写作任务" },
    ]);
    expect(maximumActive).toBe(1);
    expect(outputOf(first).theme).toBe("theme09");
    expect(JSON.stringify(outputOf(first))).not.toContain("controls");
    expect(progress).toEqual([
      { publicProgress: { label: "正在匹配“课题与核心问题导入”的版式", current: 1, total: 3 } },
      { publicProgress: { label: "正在匹配“拟人与拟物对照辨析”的版式", current: 2, total: 3 } },
      { publicProgress: { label: "正在匹配“片段写作任务”的版式", current: 3, total: 3 } },
    ]);
    await query.execute("call-2", input, new AbortController().signal);
    expect(calls).toHaveLength(3);
  });

  it("falls back from classroom keywords to the inferred visual role", async () => {
    const calls: Array<{ role: string; keyword?: string }> = [];
    const session = createPiDashiPlanningSession({
      queryLayouts: async ({ role, keyword }: { role: string; keyword?: string }) => {
        calls.push({ role, keyword });
        return keyword
          ? { layouts: [], hint: "no keyword match" }
          : { layouts: [{ layout: "theme02_page044", label: "判断框架", roles: [role], copyKeys: [] }] };
      },
      inspectLayouts: async () => ({ layouts: [] }),
    } as never, { theme: "theme02" });
    const query = session.tools.find((tool) => tool.name === "query_dashi_layouts")!;

    const result = await query.execute("query", {
      queries: [{ intent: "拟人三步分析方法支架" }],
    }, new AbortController().signal);

    expect(calls).toEqual([
      { role: "process", keyword: "拟人三步分析方法支架" },
      { role: "process", keyword: undefined },
    ]);
    expect(outputOf(result).batches[0].candidates).toHaveLength(1);
  });

  it("returns compact inspection data while preserving the raw server contract", async () => {
    const raw = {
      layouts: [{
        layout: "theme09_page008",
        label: "文本关系",
        copyKeys: ["heading", "bars[].label"],
        copyBudgets: { heading: { maxChars: 18 } },
        fillPlan: { text: [], arrays: [] },
        arrayMeta: [{ key: "bars", role: "comparison", min: 2, defaultVisibleCount: 4, maxCount: 4, countKey: "barCount" }],
        controls: [{ key: "itemCount", publicKey: "itemCount", type: "range", min: 1, max: 4, default: 4 }],
        themeScenario: "irrelevant business metadata",
      }],
    };
    let captured: unknown;
    const session = createPiDashiPlanningSession({
      queryLayouts: async () => ({ layouts: [] }),
      inspectLayouts: async () => raw,
    } as never, {
      theme: "theme09",
      onLayoutsInspected: (_layouts, inspection) => { captured = inspection; },
    });
    const inspect = session.tools.find((tool) => tool.name === "inspect_dashi_layouts")!;

    const result = await inspect.execute("inspect-1", {
      layouts: ["theme09_page008"],
    }, new AbortController().signal);

    expect(captured).toEqual(raw);
    expect(outputOf(result)).toEqual({
      layouts: [{
        layout: "theme09_page008",
        label: "文本关系",
        copyFields: ["heading", "bars[].label"],
        copyBudgets: { heading: { maxChars: 18 } },
        fillPlan: { text: [], arrays: [] },
        arrays: [{
          key: "bars",
          role: "comparison",
          minCount: 2,
          defaultVisibleCount: 4,
          maxCount: 4,
          countKey: "barCount",
        }],
      }],
    });
  });

  it("chunks a large Agent inspection into native-safe batches", async () => {
    const nativeCalls: string[][] = [];
    const session = createPiDashiPlanningSession({
      queryLayouts: async () => ({ layouts: [] }),
      inspectLayouts: async ({ layouts }: { layouts: string[] }) => {
        nativeCalls.push(layouts);
        return { layouts: layouts.map((layout) => ({ layout, copyKeys: [] })) };
      },
    } as never, { theme: "theme02" });
    const inspect = session.tools.find((tool) => tool.name === "inspect_dashi_layouts")!;
    const layouts = Array.from({ length: 20 }, (_, index) => `theme02_page${String(index + 1).padStart(3, "0")}`);

    const output = await inspect.execute("inspect-many", { layouts }, new AbortController().signal);

    expect(nativeCalls.map((call) => call.length)).toEqual([12, 8]);
    expect(outputOf(output).layouts).toHaveLength(20);
  });

  it("persists a delegated first choice before querying, then reuses it without another theme argument", async () => {
    let resolveBinding!: () => void;
    const persisted = vi.fn(() => new Promise<void>((resolve) => { resolveBinding = resolve; }));
    const queryLayouts = vi.fn(async () => ({ layouts: [{ layout: "theme10_page001" }] }));
    const session = createPiDashiPlanningSession({ queryLayouts, inspectLayouts: vi.fn() } as never, { onThemeBound: persisted });
    const query = session.tools[0]!;
    const schema = query.parameters as { properties: { theme: { anyOf: Array<{ const: string }> } }; additionalProperties: boolean };
    expect(schema.properties.theme.anyOf.map((item) => item.const)).toEqual(Array.from({ length: 12 }, (_, i) => `theme${String(i + 1).padStart(2, "0")}`));
    expect(schema.additionalProperties).toBe(false);
    const first = query.execute("first", { theme: "theme10", queries: [{ intent: "原文观察" }] });
    expect(persisted).toHaveBeenCalledExactlyOnceWith("theme10");
    expect(session.getTheme()).toBeUndefined();
    expect(queryLayouts).not.toHaveBeenCalled();
    resolveBinding();
    expect(outputOf(await first).theme).toBe("theme10");
    await query.execute("next", { queries: [{ intent: "独立练习" }] });
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(queryLayouts.mock.calls).toHaveLength(2);
    expect(queryLayouts.mock.calls.every((call) => (call as unknown as [{ theme: string }])[0].theme === "theme10")).toBe(true);
  });

  it("rejects explicit drift from a confirmed theme rather than silently ignoring the argument", async () => {
    const queryLayouts = vi.fn(async () => ({ layouts: [{ layout: "theme09_page001" }] }));
    const session = createPiDashiPlanningSession({ queryLayouts, inspectLayouts: vi.fn() } as never, { theme: "theme09" });
    await expect(session.tools[0]!.execute("wrong", { theme: "theme10", queries: [{ intent: "比较" }] })).rejects.toThrow("presentation_theme_mismatch");
    expect(queryLayouts).not.toHaveBeenCalled();
    expect(session.getTheme()).toBe("theme09");
    await session.tools[0]!.execute("fixed", { queries: [{ intent: "比较" }] });
    expect(queryLayouts).toHaveBeenCalledTimes(1);
    expect(session.getTerminalError()).toBeNull();
  });

  it("retains the persisted theme through a failed lookup and allows a same-theme retry", async () => {
    const persist = vi.fn();
    const queryLayouts = vi.fn().mockRejectedValueOnce(new Error("private service failure")).mockResolvedValue({ layouts: [{ layout: "theme11_page001" }] });
    const session = createPiDashiPlanningSession({ queryLayouts, inspectLayouts: vi.fn() } as never, { onThemeBound: persist });
    const query = session.tools[0]!;
    await expect(query.execute("first", { theme: "theme11", queries: [{ intent: "任务" }] })).rejects.toThrow("private service failure");
    expect(session.getTheme()).toBe("theme11");
    await expect(query.execute("drift", { theme: "theme12", queries: [{ intent: "任务" }] })).rejects.toThrow("presentation_theme_mismatch");
    await query.execute("retry", { queries: [{ intent: "任务" }] });
    expect(queryLayouts).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledExactlyOnceWith("theme11");
  });

  it("does not query or expose storage error details when durable binding fails", async () => {
    const queryLayouts = vi.fn();
    const session = createPiDashiPlanningSession({ queryLayouts, inspectLayouts: vi.fn() } as never, {
      onThemeBound: async () => { throw new Error("private SQL and bearer token"); },
    });
    await expect(session.tools[0]!.execute("bind", { theme: "theme12", queries: [{ intent: "任务" }] })).rejects.toThrow("presentation_theme_binding_failed");
    expect(session.getTheme()).toBeUndefined();
    expect(safeDashiPlanningError(session.getTerminalError())).toMatchObject({ code: "presentation_theme_binding_failed", terminal: true });
    expect(String(session.getTerminalError())).not.toContain("private");
    await expect(session.tools[0]!.execute("repeat", { theme: "theme01", queries: [{ intent: "任务" }] })).rejects.toThrow("presentation_theme_binding_failed");
    expect(queryLayouts).not.toHaveBeenCalled();
  });

  it("allows one contract correction then keeps a terminal failure for the native executor", async () => {
    const queryLayouts = vi.fn();
    const session = createPiDashiPlanningSession({ queryLayouts, inspectLayouts: vi.fn() } as never);
    await expect(session.tools[0]!.execute("first", { queries: [{ intent: "任务" }] })).rejects.toThrow("presentation_theme_required");
    expect(session.getTerminalError()).toBeNull();
    await expect(session.tools[0]!.execute("second", { theme: "theme99", queries: [{ intent: "任务" }] })).rejects.toThrow("presentation_planning_blocked");
    const terminal = session.getTerminalError();
    await expect(session.tools[0]!.execute("third", { theme: "theme10", queries: [{ intent: "任务" }] })).rejects.toBe(terminal);
    await expect(session.tools[1]!.execute("inspect", { layouts: ["theme10_page001"] })).rejects.toBe(terminal);
    expect(queryLayouts).not.toHaveBeenCalled();
  });

  it("requires inspection layouts to belong to the fixed theme before calling Dashi", async () => {
    const inspectLayouts = vi.fn(async () => ({ layouts: [{ layout: "theme10_page001" }] }));
    const session = createPiDashiPlanningSession({ queryLayouts: vi.fn(), inspectLayouts } as never, { theme: "theme10" });
    await expect(session.tools[1]!.execute("wrong", { layouts: ["theme01_page001"] })).rejects.toThrow("presentation_theme_mismatch");
    expect(inspectLayouts).not.toHaveBeenCalled();
    await session.tools[1]!.execute("right", { layouts: ["theme10_page001"] });
    expect(inspectLayouts).toHaveBeenCalledTimes(1);
  });

  it("reserves the first delegated theme while its persistence callback is pending", async () => {
    let resolveBinding!: () => void;
    const persist = vi.fn(() => new Promise<void>((resolve) => { resolveBinding = resolve; }));
    const queryLayouts = vi.fn(async () => ({ layouts: [{ layout: "theme10_page001" }] }));
    const session = createPiDashiPlanningSession({ queryLayouts, inspectLayouts: vi.fn() } as never, { onThemeBound: persist });
    const first = session.tools[0]!.execute("first", { theme: "theme10", queries: [{ intent: "任务" }] });
    await expect(session.tools[0]!.execute("race", { theme: "theme11", queries: [{ intent: "任务" }] })).rejects.toThrow("presentation_theme_mismatch");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(queryLayouts).not.toHaveBeenCalled();
    resolveBinding();await first;
    expect(session.getTheme()).toBe("theme10");
  });

  it("keeps the query tool schema identical whether or not a theme is already bound", () => {
    const dashi = {
      queryLayouts: async () => ({ layouts: [] }),
      inspectLayouts: async () => ({ layouts: [] }),
    };
    const bound = createPiDashiPlanningSession(dashi as never, { theme: "theme09" });
    const unbound = createPiDashiPlanningSession(dashi as never);
    const toolJson = (session: ReturnType<typeof createPiDashiPlanningSession>) => JSON.stringify(
      session.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    );
    expect(toolJson(bound)).toBe(toolJson(unbound));
    expect(toolJson(bound)).toContain("theme01");
    expect(toolJson(bound)).toContain("theme12");
  });
});
