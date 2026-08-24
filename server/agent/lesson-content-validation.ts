import type { LessonPlan } from "../domain.js";

export type LessonContentIssue = {
  code: "spring_baby_metaphor_misclassified" | "spring_rain_metaphor_misclassified";
  message: string;
};

const compact = (value: string) => value
  .normalize("NFKC")
  .replace(/[\s“”‘’'"《》〈〉，,。；;：:、（）()]/g, "");

const windowsAround = (text: string, needle: string, radius = 36) => {
  const result: string[] = [];
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    result.push(text.slice(Math.max(0, index - radius), index + needle.length + radius));
    from = index + needle.length;
  }
  return result;
};

/**
 * Narrow deterministic checks for factual regressions already observed in the
 * canonical upstream blueprint and generated lesson. This is intentionally not
 * a general Chinese-language classifier; it blocks only concrete, verified bad
 * claims while broader subject truth remains the Agent's evidence-backed job.
 */
export function findKnownLessonContentIssues(value: string | LessonPlan): LessonContentIssue[] {
  const raw = typeof value === "string" ? value : Object.values(value).join("\n");
  const clauses = raw
    .normalize("NFKC")
    .split(/(?:\\n|\n|[。；;！？!?])/)
    .map(compact)
    .filter(Boolean);
  const issues: LessonContentIssue[] = [];
  const babyMisclassified = clauses.flatMap((clause) => (
    windowsAround(clause, "春天像刚落地的娃娃")
  ))
    .some((window) => window.includes("借喻") || window.includes("本体不出现"));
  if (babyMisclassified) {
    issues.push({
      code: "spring_baby_metaphor_misclassified",
      message: "“春天像刚落地的娃娃”同时出现本体“春天”、比喻词“像”和喻体“娃娃”，不能表述为借喻或本体不出现。",
    });
  }
  const rainMisclassified = clauses.flatMap((clause) => (
    windowsAround(clause, "像牛毛像花针像细丝")
  ))
    .some((window) => window.includes("借喻"));
  if (rainMisclassified) {
    issues.push({
      code: "spring_rain_metaphor_misclassified",
      message: "“像牛毛，像花针，像细丝”不能仅因本体承前省略就判作借喻；没有直接核验依据时不要用它强行覆盖借喻类别。",
    });
  }
  return issues;
}
