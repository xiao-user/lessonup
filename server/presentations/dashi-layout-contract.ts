import type { DashiGoal } from "./dashi-goal.js";

type FillPlanArray = {
  key?: unknown;
  visibleCount?: unknown;
  countKey?: unknown;
  itemFields?: unknown;
};

type MediaSlot = {
  field?: unknown;
  fieldPath?: unknown;
  presetProp?: unknown;
  countKey?: unknown;
};

export type DashiLayoutContract = {
  layout: string;
  copyKeys: string[];
  fillPlan?: {
    text?: Array<{ key?: unknown }>;
    arrays?: FillPlanArray[];
  };
  mediaSlots: MediaSlot[];
};

function asContract(value: unknown): DashiLayoutContract | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.layout !== "string") return null;
  const rawFillPlan = candidate.fillPlan && typeof candidate.fillPlan === "object"
    ? candidate.fillPlan as Record<string, unknown>
    : null;
  return {
    layout: candidate.layout,
    copyKeys: Array.isArray(candidate.copyKeys)
      ? candidate.copyKeys.filter((key): key is string => typeof key === "string")
      : [],
    fillPlan: rawFillPlan ? {
      text: Array.isArray(rawFillPlan.text) ? rawFillPlan.text as Array<{ key?: unknown }> : [],
      arrays: Array.isArray(rawFillPlan.arrays) ? rawFillPlan.arrays as FillPlanArray[] : [],
    } : undefined,
    mediaSlots: Array.isArray(candidate.mediaSlots) ? candidate.mediaSlots as MediaSlot[] : [],
  };
}

/** Convert either Dashi's single-layout or batch inspection response into a stable lookup. */
export function indexDashiLayoutContracts(result: unknown) {
  const root = result && typeof result === "object" ? result as Record<string, unknown> : null;
  const candidates = Array.isArray(root?.layouts) ? root.layouts : [result];
  const contracts = new Map<string, DashiLayoutContract>();
  for (const candidate of candidates) {
    const contract = asContract(candidate);
    if (contract) contracts.set(contract.layout, contract);
  }
  return contracts;
}

function isMeaningful(value: unknown) {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return value !== null && value !== undefined;
}

function valuesAtPath(value: unknown, segments: string[]): unknown[] {
  if (!segments.length) return [value];
  if (!value || typeof value !== "object") return [];
  const [segment, ...rest] = segments;
  const isArray = segment.endsWith("[]");
  const key = isArray ? segment.slice(0, -2) : segment;
  const child = (value as Record<string, unknown>)[key];
  if (!isArray) return valuesAtPath(child, rest);
  if (!Array.isArray(child)) return [];
  return child.flatMap((item) => valuesAtPath(item, rest));
}

function valueAtPath(value: unknown, path: string) {
  let current = value;
  for (const segment of path.split(".")) {
    if (!segment || segment.endsWith("[]") || !current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setValueAtPath(value: Record<string, unknown>, path: string, nextValue: unknown) {
  const segments = path.split(".");
  if (!segments.length || segments.some((segment) => !segment || segment.endsWith("[]"))) return;
  let current = value;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (!child || typeof child !== "object" || Array.isArray(child)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = nextValue;
}

/**
 * Dashi renders sparse authored props on top of template defaults. If a model
 * supplies fewer array items but leaves a template count at its default, the
 * runtime deliberately pads the array with demo rows. Bind every exposed count
 * to the authored array length before approval so classroom decks can never
 * acquire unrelated template copy during rendering.
 */
function bindAuthoredArrayCounts(
  props: Record<string, unknown>,
  arrays: FillPlanArray[],
) {
  for (const plan of arrays) {
    if (typeof plan.key !== "string" || typeof plan.countKey !== "string") continue;
    const value = valueAtPath(props, plan.key);
    if (!Array.isArray(value)) continue;
    setValueAtPath(props, plan.countKey, value.length);
  }
}

/**
 * Dashi merges omitted props with template defaults. Therefore every visible
 * copy field from the exact inspected layout must be present before a teacher
 * can approve the goal; validating only fields the model happened to send is
 * insufficient and leaks demo copy into the rendered classroom deck.
 */
export function assertDashiGoalHasCompleteVisibleCopy(
  goal: DashiGoal,
  contracts: ReadonlyMap<string, DashiLayoutContract>,
) {
  const errors: string[] = [];
  for (const [slideIndex, slide] of goal.slides.entries()) {
    const contract = contracts.get(slide.layout);
    if (!contract) {
      errors.push(`slides[${slideIndex}].layout:${slide.layout}:inspection_contract_missing`);
      continue;
    }
    const requiredKeys = new Set([
      ...contract.copyKeys,
      ...(contract.fillPlan?.text ?? [])
        .map((item) => item.key)
        .filter((key): key is string => typeof key === "string"),
    ]);
    for (const key of requiredKeys) {
      const values = valuesAtPath(slide.props, key.split("."));
      if (!values.length || values.some((value) => !isMeaningful(value))) {
        errors.push(`slides[${slideIndex}].props.${key}:visible_copy_required`);
      }
    }
  }
  if (errors.length) {
    throw new Error(`dashi_visible_copy_incomplete:${JSON.stringify(errors.slice(0, 16))}`);
  }
}

function rootKey(value: unknown) {
  if (typeof value !== "string") return null;
  return value.split(".")[0]?.replace(/\[\]$/, "") || null;
}

/**
 * LessonUp uses Dashi's default lock-template mode. Pi authors classroom copy,
 * array contents/counts and real media only; visual controls stay owned by the
 * selected layout. Removing every other top-level prop prevents a control from
 * one inspected layout leaking into another while required-copy validation
 * still catches misspelled or omitted classroom content.
 */
export function keepOnlyDashiAuthoredContent(
  goal: DashiGoal,
  contracts: ReadonlyMap<string, DashiLayoutContract>,
): DashiGoal {
  return {
    ...goal,
    slides: goal.slides.map((slide) => {
      const contract = contracts.get(slide.layout);
      if (!contract) return slide;
      const allowed = new Set<string>();
      for (const key of contract.copyKeys) {
        const root = rootKey(key);
        if (root) allowed.add(root);
      }
      for (const text of contract.fillPlan?.text ?? []) {
        const root = rootKey(text.key);
        if (root) allowed.add(root);
      }
      for (const array of contract.fillPlan?.arrays ?? []) {
        const arrayRoot = rootKey(array.key);
        const countRoot = rootKey(array.countKey);
        if (arrayRoot) allowed.add(arrayRoot);
        if (countRoot) allowed.add(countRoot);
      }
      for (const media of contract.mediaSlots) {
        for (const key of [media.field, media.fieldPath, media.presetProp, media.countKey]) {
          const root = rootKey(key);
          if (root) allowed.add(root);
        }
      }
      return {
        ...slide,
        props: (() => {
          const props = structuredClone(Object.fromEntries(
            Object.entries(slide.props).filter(([key]) => allowed.has(key)),
          ));
          bindAuthoredArrayCounts(props, contract.fillPlan?.arrays ?? []);
          return props;
        })(),
      };
    }),
  };
}
