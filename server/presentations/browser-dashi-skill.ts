import { createHash } from "node:crypto";
import { dashiGoalSchema, type DashiGoal } from "./dashi-goal.js";
import { goalToBrowserDeck, type BrowserDeck } from "../../src/lib/dashi-browser/goal-to-deck.js";
import { buildDashiContentArtifact, readDashiContentArtifact } from "../../src/lib/dashi-browser/native-editor-document.js";
import type { NativeDashiBundle, NativeDashiDeck } from "./dashi-skill-port.js";

export type DashiPlanningRow = {
  layout: string;
  theme?: string;
  label?: string;
  slot?: string;
  pageNumber?: number;
  roles?: string[];
  copyKeys?: unknown;
  copyBudgets?: unknown;
  fillPlan?: unknown;
  arrayMeta?: unknown;
  mediaSlots?: unknown;
  propShapes?: unknown;
  contentLocked?: unknown;
  [key: string]: unknown;
};

export type DashiPlanningCatalog = {
  theme: string;
  layouts: DashiPlanningRow[];
};

export type DashiRuntimeCatalog = {
  version: number;
  theme: string;
  layouts: Record<string, {
    key: string;
    themePack: string;
    dataLayout: string;
    label: string;
    bgClass: string;
    controls: unknown[];
    defaultProps: Record<string, unknown>;
  }>;
};

type DeckWorkspace = {
  goal: DashiGoal;
  deck: BrowserDeck;
  runtimeCatalog: DashiRuntimeCatalog;
};

function hashSeed(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function mediaCapacity(row: DashiPlanningRow) {
  return asArray(row.mediaSlots).reduce((max, slot) => {
    const item = slot && typeof slot === "object" ? slot as Record<string, unknown> : {};
    return Math.max(max, Number(item.maxCount || item.max || item.defaultCount || item.visibleCount || 1) || 0);
  }, 0);
}

function scoreRow(row: DashiPlanningRow, query: { role: string; keyword: string; needsMedia: boolean }) {
  const roles = asArray(row.roles).map((role) => String(role).toLowerCase());
  const searchText = `${row.layout} ${row.label ?? ""} ${row.slot ?? ""} ${roles.join(" ")}`.toLowerCase();
  let score = 0;
  if (query.role && roles.includes(query.role)) score += 20;
  if (query.keyword && searchText.includes(query.keyword)) score += 10;
  if (query.needsMedia && mediaCapacity(row) > 0) score += 8;
  if (!query.needsMedia && mediaCapacity(row) > 0) score -= 1;
  return score;
}

/**
 * Cloudflare-safe Dashi planning and persistence. Query/inspect read a
 * precomputed catalog; rendering is the browser harness, not a Node process.
 */
export class BrowserDashiSkill {
  private readonly workspaces = new Map<string, DeckWorkspace>();
  private readonly catalogs = new Map<string, DashiPlanningCatalog>();

  private readonly loadRuntimeCatalog: (theme: DashiGoal["themePack"]) => Promise<DashiRuntimeCatalog>;

  constructor(
    private readonly loadThemeCatalog: (theme: DashiGoal["themePack"]) => Promise<DashiPlanningCatalog>,
    runtimeCatalogLoader?: (theme: DashiGoal["themePack"]) => Promise<DashiRuntimeCatalog>,
  ) {
    this.loadRuntimeCatalog = runtimeCatalogLoader ?? (async (theme) => {
      const planning = await this.catalogFor(theme);
      return {
        version: 1,
        theme,
        layouts: Object.fromEntries(planning.layouts.map((row) => [row.layout, {
          key: row.layout,
          themePack: row.theme ?? theme,
          dataLayout: row.layout,
          label: row.label ?? row.layout,
          bgClass: "",
          controls: [],
          defaultProps: {},
        }])),
      };
    });
  }

  private async catalogFor(theme: DashiGoal["themePack"]) {
    const cached = this.catalogs.get(theme);
    if (cached) return cached;
    const catalog = await this.loadThemeCatalog(theme);
    this.catalogs.set(theme, catalog);
    return catalog;
  }

  private async row(layout: string) {
    const theme = layout.match(/^(theme(?:0[1-9]|1[0-2]))_/)?.[1] as DashiGoal["themePack"] | undefined;
    if (!theme) return null;
    return (await this.catalogFor(theme)).layouts.find((item) => item.layout === layout) ?? null;
  }

  async queryLayouts(input: {
    theme: DashiGoal["themePack"];
    role: string;
    keyword?: string;
    seed?: string;
    limit?: number;
    signal?: AbortSignal;
  }) {
    if (input.signal?.aborted) throw new Error("presentation_cancelled");
    const role = String(input.role || "").trim().toLowerCase();
    const keyword = String(input.keyword || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(100, Number(input.limit) || 12));
    const catalog = await this.catalogFor(input.theme);
    const scored = catalog.layouts
      .filter((row) => !role || asArray(row.roles).map((item) => String(item).toLowerCase()).includes(role))
      .filter((row) => {
        if (!keyword) return true;
        const searchText = `${row.layout} ${row.label ?? ""} ${row.slot ?? ""}`.toLowerCase();
        return searchText.includes(keyword);
      })
      .map((row) => ({ row, score: scoreRow(row, { role, keyword, needsMedia: false }) }))
      .sort((left, right) => {
        const diff = right.score - left.score;
        if (diff !== 0) return diff;
        const seed = input.seed ?? "";
        return hashSeed(`${seed}:${right.row.layout}`) - hashSeed(`${seed}:${left.row.layout}`);
      })
      .slice(0, limit)
      .map(({ row }) => row);
    return {
      theme: input.theme,
      role: role || null,
      keyword: keyword || null,
      limit,
      seed: input.seed ?? null,
      count: scored.length,
      layouts: scored,
      ...(scored.length ? {} : {
        hint: role
          ? `role "${role}" 在该条件下无候选;可用 role 见 availableRoles,或去掉 --role 用 --keyword 搜索`
          : "无候选;试试更换 --keyword 或去掉媒体条件",
        availableRoles: [...new Set(catalog.layouts.flatMap((row) => asArray(row.roles).map(String)))],
      }),
    };
  }

  async inspectLayouts(input: { layouts: string[]; signal?: AbortSignal }) {
    if (input.signal?.aborted) throw new Error("presentation_cancelled");
    if (!input.layouts.length || input.layouts.length > 12) throw new Error("dashi_layout_selection_invalid");
    const layouts = [];
    const unknown = [];
    for (const layout of input.layouts) {
      const row = await this.row(layout);
      if (row) layouts.push(row);
      else unknown.push(layout);
    }
    if (unknown.length) throw new Error(`Unknown layout(s): ${unknown.join(", ")}`);
    return layouts.length === 1 ? layouts[0] : { layouts };
  }

  async prepareGoal(goalInput: DashiGoal, signal?: AbortSignal): Promise<DashiGoal> {
    if (signal?.aborted) throw new Error("presentation_cancelled");
    const goal = dashiGoalSchema.parse(goalInput);
    for (const [index, slide] of goal.slides.entries()) {
      const row = await this.row(slide.layout);
      if (!row) throw new Error(`dashi_native_goal_validation_failed: unknown layout ${slide.layout}`);
      if (row.theme && row.theme !== goal.themePack) {
        throw new Error(`dashi_native_goal_validation_failed: slides[${index}].layout theme mismatch`);
      }
    }
    return goal;
  }

  async renderGoal(input: {
    presentationId: string;
    goal: DashiGoal;
    signal?: AbortSignal;
  }): Promise<NativeDashiDeck> {
    if (input.signal?.aborted) throw new Error("presentation_cancelled");
    const goal = dashiGoalSchema.parse({
      ...input.goal,
      pageCount: input.goal.slides.length,
    });
    await this.prepareGoal(goal, input.signal);
    const [deck, runtimeCatalog] = await Promise.all([
      Promise.resolve(goalToBrowserDeck(goal, { id: input.presentationId, title: goal.title })),
      this.loadRuntimeCatalog(goal.themePack),
    ]);
    this.workspaces.set(input.presentationId, { goal, deck, runtimeCatalog });
    const encoded = JSON.stringify(goal);
    return {
      deckKey: input.presentationId,
      previewUrl: `/classroom-presentations/${input.presentationId}`,
      checksum: createHash("sha256").update(encoded).digest("hex"),
      pageCount: goal.slides.length,
    };
  }

  async hasDeck(presentationId: string) {
    return this.workspaces.has(presentationId);
  }

  async open(presentationId: string) {
    if (!this.workspaces.has(presentationId)) throw new Error("presentation_native_deck_missing");
    return `/classroom-presentations/${presentationId}`;
  }

  async remove(presentationId: string) {
    this.workspaces.delete(presentationId);
  }

  async getBrowserDeck(presentationId: string) {
    const workspace = this.workspaces.get(presentationId);
    if (!workspace) throw new Error("presentation_native_deck_missing");
    return structuredClone(workspace.deck);
  }

  async replaceBrowserDeck(presentationId: string, input: unknown) {
    const workspace = this.workspaces.get(presentationId);
    if (!workspace) throw new Error("presentation_native_deck_missing");
    if (!input || typeof input !== "object" || !Array.isArray((input as BrowserDeck).slides)) {
      throw new Error("presentation_deck_invalid");
    }
    const deck = structuredClone(input as BrowserDeck);
    if (deck.id !== presentationId) throw new Error("presentation_deck_scope_invalid");
    workspace.deck = deck;
  }

  async exportBundle(presentationId: string, revision?: { goal: DashiGoal; deck: BrowserDeck }): Promise<NativeDashiBundle> {
    const workspace = this.workspaces.get(presentationId);
    if (!workspace) throw new Error("presentation_native_deck_missing");
    const html = buildDashiContentArtifact({
      goal: revision?.goal ?? workspace.goal,
      deck: revision?.deck ?? workspace.deck,
      runtimeCatalog: workspace.runtimeCatalog,
    });
    const files = [{ path: "index.html", body: new TextEncoder().encode(html) }];
    return {
      files,
      byteSize: files.reduce((total, file) => total + file.body.byteLength, 0),
    };
  }

  async importBundle(presentationId: string, bundle: NativeDashiBundle) {
    const htmlFile = bundle.files.find((file) => file.path === "index.html");
    if (!htmlFile) throw new Error("presentation_native_deck_missing");
    let rawGoal: unknown;
    let rawDeck: unknown;
    try {
      const artifact = readDashiContentArtifact(new TextDecoder().decode(htmlFile.body));
      rawGoal = artifact.goal;
      rawDeck = artifact.deck;
    } catch {
      // Read the previous three-file format long enough to migrate it on the
      // next successful edit. New writes never recreate these JSON objects.
      const goalFile = bundle.files.find((file) => file.path === "goal.json");
      const deckFile = bundle.files.find((file) => file.path === "deck.json");
      if (!goalFile) throw new Error("presentation_native_deck_missing");
      rawGoal = JSON.parse(new TextDecoder().decode(goalFile.body));
      rawDeck = deckFile ? JSON.parse(new TextDecoder().decode(deckFile.body)) : null;
    }
    const goal = dashiGoalSchema.parse(rawGoal);
    const deck = (rawDeck ?? goalToBrowserDeck(goal, { id: presentationId, title: goal.title })) as BrowserDeck;
    if (deck.id !== presentationId) throw new Error("presentation_deck_scope_invalid");
    const runtimeCatalog = await this.loadRuntimeCatalog(goal.themePack);
    this.workspaces.set(presentationId, { goal, deck, runtimeCatalog });
  }
}

export async function loadDashiPlanningCatalogFromAssets(
  assets: { fetch: (request: Request) => Promise<Response> },
  theme: DashiGoal["themePack"],
): Promise<DashiPlanningCatalog> {
  const response = await assets.fetch(new Request(`https://assets.local/dashi/planning/${theme}.json`));
  if (!response.ok) throw new Error(`dashi_planning_catalog_missing:${theme}`);
  return response.json() as Promise<DashiPlanningCatalog>;
}

export async function loadDashiRuntimeCatalogFromAssets(
  assets: { fetch: (request: Request) => Promise<Response> },
  theme: DashiGoal["themePack"],
): Promise<DashiRuntimeCatalog> {
  const response = await assets.fetch(new Request(`https://assets.local/dashi/runtime/${theme}.json`));
  if (!response.ok) throw new Error(`dashi_runtime_catalog_missing:${theme}`);
  return response.json() as Promise<DashiRuntimeCatalog>;
}
