import { describe, expect, it } from "vitest";
import { BrowserDashiSkill } from "./browser-dashi-skill.js";
import type { DashiGoal } from "./dashi-goal.js";
import { MemoryObjectStorage } from "../platform/object-storage.js";
import { PresentationArtifactStorage } from "./storage.js";
import { nativeStateToBrowserDeck, buildNativeDashiEditorDocument } from "../../src/lib/dashi-browser/native-editor-document.js";
import { readFileSync } from "node:fs";

const catalog = {
  theme: "theme07" as const,
  layouts: [
    {
      layout: "theme07_page001",
      theme: "theme07",
      label: "封面",
      roles: ["cover"],
      copyKeys: ["title"],
      fillPlan: { text: [{ key: "title" }], arrays: [] },
      arrayMeta: [],
      mediaSlots: [],
    },
    {
      layout: "theme07_page021",
      theme: "theme07",
      label: "探究",
      roles: ["process"],
      copyKeys: ["title", "content"],
      fillPlan: { text: [{ key: "title" }], arrays: [] },
      arrayMeta: [],
      mediaSlots: [],
    },
  ],
};

const runtimeCatalog = {
  version: 1,
  theme: "theme07",
  layouts: Object.fromEntries(catalog.layouts.map((row) => [row.layout, {
    key: row.layout,
    themePack: "theme07",
    dataLayout: row.layout,
    label: row.label,
    bgClass: "",
    controls: [],
    defaultProps: {},
  }])),
};

const goal: DashiGoal = {
  title: "课题 · 课堂演示",
  goal: "学生能回答中心问题",
  themePack: "theme07",
  slides: [
    { layout: "theme07_page001", props: { title: "课题" } },
    { layout: "theme07_page021", props: { title: "探究", content: "完成任务" } },
  ],
};

describe("BrowserDashiSkill", () => {
  it("round-trips authored content and native edits through HTML storage without changing the editor document", async () => {
    const create = () => new BrowserDashiSkill(async () => catalog, async () => runtimeCatalog);
    const dashi = create();
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await dashi.renderGoal({ presentationId: id, goal });
    const deck = await dashi.getBrowserDeck(id);
    const edited = nativeStateToBrowserDeck(deck, {
      props: { [deck.slides[0]!.id]: { scheme: 'purple', title: '编辑后的课题' } },
      text: { 'lesson-title': '教师修改的标题' },
      media: {}, slideOrder: deck.slides.map(slide => slide.id).reverse(),
    });
    await dashi.replaceBrowserDeck(id, edited);
    const objects = new MemoryObjectStorage();
    const storage = new PresentationArtifactStorage(objects);
    const bundle = await dashi.exportBundle(id);
    await storage.save(owner, id, bundle);
    const restored = create();
    await restored.importBundle(id, await storage.load(owner, id, storage.keyFor(owner, id)));
    expect(await restored.getBrowserDeck(id)).toEqual(edited);
    expect((await restored.exportBundle(id)).files[0]!.body).toEqual(bundle.files[0]!.body);
    const template = readFileSync('server/agent/skills/dashi-ppt/project/assets/template-swiss.html', 'utf8');
    const editor = (deck: Parameters<typeof buildNativeDashiEditorDocument>[0]['deck']) => buildNativeDashiEditorDocument({ template, deck, runtimeCatalog, assetBaseUrl: 'https://example.com/dashi/' });
    expect(editor(await restored.getBrowserDeck(id))).toBe(editor(edited));
    expect(await objects.list(`${owner}/presentations/${id}`)).toHaveLength(1);
  });
  it("queries and inspects layouts from an in-process catalog", async () => {
    const dashi = new BrowserDashiSkill(async () => catalog, async () => runtimeCatalog);
    const queried = await dashi.queryLayouts({ theme: "theme07", role: "cover", limit: 4 });
    expect(queried.count).toBe(1);
    expect(queried.layouts[0]?.layout).toBe("theme07_page001");
    const inspected = await dashi.inspectLayouts({ layouts: ["theme07_page001"] });
    expect(inspected).toMatchObject({ layout: "theme07_page001", copyKeys: ["title"] });
  });

  it("persists a browser deck bundle from a Dashi goal", async () => {
    const dashi = new BrowserDashiSkill(async () => catalog, async () => runtimeCatalog);
    const presentationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const deck = await dashi.renderGoal({ presentationId, goal });
    expect(deck.pageCount).toBe(2);
    expect(deck.previewUrl).toBe(`/classroom-presentations/${presentationId}`);
    const bundle = await dashi.exportBundle(presentationId);
    expect(bundle.files.map((file) => file.path)).toEqual(["index.html"]);
    const html = new TextDecoder().decode(bundle.files[0]?.body);
    expect(html).toContain('data-dashi-content-artifact="1"');
    expect(html).toContain("完成任务");

    const restored = new BrowserDashiSkill(async () => catalog, async () => runtimeCatalog);
    await restored.importBundle(presentationId, bundle);
    await expect(restored.getBrowserDeck(presentationId)).resolves.toMatchObject({ id: presentationId, title: goal.title });
  });
});
