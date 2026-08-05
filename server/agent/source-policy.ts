import type { SourceRef } from "../domain.js";

export function isInternalCurriculumAssetUrl(value?: string) {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "ykt.cbern.com.cn" || hostname.endsWith(".ykt.cbern.com.cn");
  } catch {
    return false;
  }
}

export function withoutInternalCurriculumAssetUrl<T extends { url?: string }>(source: T): T {
  if (!isInternalCurriculumAssetUrl(source.url)) return source;
  const { url: _url, ...withoutUrl } = source;
  return withoutUrl as T;
}

/** Keep curriculum provenance visible without presenting an inaccessible object URL. */
export function presentableSource(source: SourceRef): SourceRef {
  return withoutInternalCurriculumAssetUrl(source);
}
