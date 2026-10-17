import { type NormalizedAgentEvent } from "../../domain.js";
import type { BrowserDashiSkill } from "../../presentations/browser-dashi-skill.js";

export type Emit = (
  event: NormalizedAgentEvent,
  delivery?: { persist?: boolean },
) => void | Promise<void>;

export type PiDashi = Pick<BrowserDashiSkill, "queryLayouts" | "inspectLayouts" | "prepareGoal" | "renderGoal">;
export const RUN_LEASE_MS = 30_000;
export const RUN_HEARTBEAT_MS = 8_000;
export const piAgentDefinitionVersion = "lesson-preparation-manager@5.0.0+pi-0.84.2";
