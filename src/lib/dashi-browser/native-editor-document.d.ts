import type { DashiGoal } from "../../../server/presentations/dashi-goal.js";
import type { BrowserDeck } from "./goal-to-deck.js";

export type DashiEditorRuntimeCatalog = {
  version?: number;
  theme?: string;
  layouts: Record<string, {
    themePack?: string;
    dataLayout?: string;
    label?: string;
    bgClass?: string;
    controls?: unknown[];
    defaultProps?: Record<string, unknown>;
  }>;
};

export function buildDashiContentArtifact(input: {
  runtimeCatalog: DashiEditorRuntimeCatalog;
  deck: BrowserDeck;
  goal: DashiGoal;
}): string;

export function readDashiContentArtifact(html: string): {
  goal: unknown;
  deck: unknown;
};

export function buildNativeDashiEditorDocument(input: {
  template: string;
  runtimeCatalog: DashiEditorRuntimeCatalog;
  deck: BrowserDeck;
  assetBaseUrl?: string;
}): string;

export function nativeStateToBrowserDeck(deck: BrowserDeck, state: unknown): BrowserDeck;

export const SAVE_MESSAGE: string;
