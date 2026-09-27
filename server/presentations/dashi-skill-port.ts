export type NativeDashiDeck = {
  deckKey: string;
  previewUrl: string;
  checksum: string;
  pageCount: number;
};

export type NativeDashiBundle = {
  files: Array<{ path: string; body: Uint8Array }>;
  byteSize: number;
};

export type DashiDeckWorkspace = {
  open: (presentationId: string) => Promise<string>;
  remove: (presentationId: string) => Promise<void>;
  hasDeck: (presentationId: string) => Promise<boolean>;
  exportBundle: (presentationId: string, revision?: { goal: import("./dashi-goal.js").DashiGoal; deck: import("../../src/lib/dashi-browser/goal-to-deck.js").BrowserDeck }) => Promise<NativeDashiBundle>;
  importBundle: (presentationId: string, bundle: NativeDashiBundle) => Promise<void>;
  getBrowserDeck?: (presentationId: string) => Promise<unknown>;
  replaceBrowserDeck?: (presentationId: string, deck: unknown) => Promise<void>;
};
