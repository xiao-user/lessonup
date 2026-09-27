import type { WebSearchProvider } from "./web-search.js";

/** Safe default for runtimes without the hardened Node URL-fetch adapter. */
export class UnavailableWebSearchProvider implements WebSearchProvider {
  async search(): Promise<never> { throw new Error("web_search_not_configured"); }
  async open(): Promise<never> { throw new Error("web_search_not_configured"); }
}
