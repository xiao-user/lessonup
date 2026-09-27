type GoalLike = {
  title: string;
  themePack: string;
  slides: Array<{ layout: string; props?: Record<string, unknown> }>;
};

type BrowserVariantLike = {
  id?: string;
  stateId?: string;
  kind?: string;
  layout?: string;
  props?: Record<string, unknown>;
  contentMap?: Record<string, unknown>;
};

type BrowserSlideLike = {
  id?: string;
  selectedVariant?: string;
  content?: Record<string, unknown>;
  variants?: BrowserVariantLike[];
};

type EditableBrowserDeckLike = {
  title?: string;
  theme?: string;
  slides?: BrowserSlideLike[];
  state?: {
    props?: Record<string, Record<string, unknown>>;
    variantSelection?: Record<string, string>;
  };
};

function cloneRecord(value: Record<string, unknown> | undefined) {
  return structuredClone(value ?? {});
}

function collectStringPaths(value: unknown, prefix = "", output: string[] = []) {
  if (typeof value === "string") {
    if (prefix) output.push(prefix);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStringPaths(item, `${prefix}[${index}]`, output));
    return output;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, child]) => (
      collectStringPaths(child, prefix ? `${prefix}.${key}` : key, output)
    ));
  }
  return output;
}

function pathTokens(path: string) {
  return [...path.matchAll(/([A-Za-z_$][\w$-]*)|\[(\d+)\]/g)]
    .map((match) => match[1] ?? Number(match[2]));
}

function readPath(value: unknown, path: string) {
  let current = value;
  for (const token of pathTokens(path)) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[token];
  }
  return current;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown) {
  const tokens = pathTokens(path);
  if (!tokens.length) return;
  let current: any = target;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index]!;
    const nextToken = tokens[index + 1]!;
    if (!current[token] || typeof current[token] !== "object") {
      current[token] = typeof nextToken === "number" ? [] : {};
    }
    current = current[token];
  }
  current[tokens.at(-1)!] = structuredClone(value);
}

function mergeRecords(base: Record<string, unknown>, override: Record<string, unknown>) {
  const result = cloneRecord(base);
  for (const [key, value] of Object.entries(override)) {
    const previous = result[key];
    result[key] = previous && value
      && typeof previous === "object" && !Array.isArray(previous)
      && typeof value === "object" && !Array.isArray(value)
      ? mergeRecords(previous as Record<string, unknown>, value as Record<string, unknown>)
      : structuredClone(value);
  }
  return result;
}

/**
 * LessonUp stores a Dashi-native goal (layout + authored props).
 * The browser harness mounts a deck spec; this is the only conversion.
 */
export function goalToBrowserDeck(goal: GoalLike, options: { id?: string; title?: string } = {}) {
  const slides = goal.slides.map((slide, index) => {
    const content = cloneRecord(slide.props);
    const slideId = `slide-${index + 1}`;
    return {
      id: slideId,
      label: slide.layout,
      selectedVariant: "v1" as const,
      content,
      variants: [{
        id: "v1" as const,
        stateId: `${slideId}::v1`,
        kind: "template" as const,
        layout: slide.layout,
        props: cloneRecord(slide.props),
        // Legacy goals have no canonical content model. Give them an exact
        // identity projection so browser edits round-trip without changing
        // what the approved Dashi runtime renders.
        contentMap: Object.fromEntries(collectStringPaths(content).map((path) => [path, path])),
      }],
    };
  });
  return {
    schema: "dashi.browser.deck/v1",
    id: String(options.id || `deck-${crypto.randomUUID()}`),
    title: String(options.title || goal.title || "课堂演示"),
    theme: goal.themePack,
    slides,
    state: {
      slideOrder: slides.map((slide) => slide.id),
      props: {},
      text: {},
      media: {},
      variantSelection: Object.fromEntries(slides.map((slide) => [slide.id, slide.variants[0].stateId])),
    },
  };
}

/** Convert the editable browser state back into the persisted legacy goal. */
export function browserDeckToGoal(deck: EditableBrowserDeckLike, baseGoal: GoalLike) {
  if (!Array.isArray(deck.slides) || deck.slides.length !== baseGoal.slides.length) {
    throw new Error("presentation_deck_slide_count_mismatch");
  }
  if (deck.theme !== baseGoal.themePack) throw new Error("presentation_deck_theme_mismatch");
  return {
    ...baseGoal,
    title: typeof deck.title === "string" && deck.title.trim() ? deck.title.trim() : baseGoal.title,
    slides: deck.slides.map((slide, index) => {
      const variants = Array.isArray(slide.variants) ? slide.variants : [];
      const selectedState = deck.state?.variantSelection?.[slide.id ?? ""] ?? slide.selectedVariant;
      const variant = variants.find((item) => item.stateId === selectedState || item.id === selectedState)
        ?? variants[0];
      if (!variant || variant.kind !== "template" || variant.layout !== baseGoal.slides[index]?.layout) {
        throw new Error("presentation_deck_layout_mismatch");
      }
      let props = mergeRecords(
        variant.props ?? {},
        variant.stateId ? deck.state?.props?.[variant.stateId] ?? {} : {},
      );
      for (const [target, source] of Object.entries(variant.contentMap ?? {})) {
        if (typeof source !== "string") continue;
        const value = readPath(slide.content, source.replace(/^content\./, ""));
        if (value !== undefined) writePath(props, target, value);
      }
      return { layout: variant.layout, props };
    }),
  };
}

export type BrowserDeck = ReturnType<typeof goalToBrowserDeck>;
