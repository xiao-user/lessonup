import { z } from "zod";

export const OBSERVATION_METHODS = ["document_check", "student_work", "assessment", "teacher_observation"] as const;
const text = (max: number) => z.string().trim().min(1).max(max);

/** A checkable claim and its measurement conditions, not a promise of causal improvement. */
export const observationPlanSchema = z.object({
  kind: z.enum(["design_check", "learning_change"])
    .describe("design_check checks the lesson design itself; learning_change compares student observations under the same criterion and conditions. Neither proves causal effects."),
  objective: text(500),
  task: text(2_000),
  criterion: text(1_000),
  learnerGroup: text(300),
  method: z.enum(OBSERVATION_METHODS),
  conditions: z.string().trim().max(1_000).default(""),
  baselineEvidenceId: z.string().uuid().nullable().default(null),
}).strict().superRefine((plan, context) => {
  if ((plan.kind === "design_check") !== (plan.method === "document_check")) {
    context.addIssue({ code: "custom", path: ["method"], message: "observation_method_kind_mismatch" });
  }
});
export type ObservationPlan = z.infer<typeof observationPlanSchema>;

export function isSyntheticObservation(value: { synthetic?: boolean; observation?: string; sourceReference?: string }) {
  return value.synthetic === true || /合成(?:验收|评测|演示|数据|样本)|演示数据|非真实(?:课堂|学生)|不代表真实(?:课堂|学生)|synthetic\s+(?:data|sample|evaluation)/i.test(`${value.observation ?? ""}\n${value.sourceReference ?? ""}`);
}

export const normalizeObservationText = (value: string | undefined) => (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
export const observationCriteria = ["objective", "criterion", "learnerGroup", "conditions", "method"] as const;

export function observationsComparable(
  left: { objective: string; criterion: string; learnerGroup: string; conditions?: string; method: string; task?: string },
  right: { objective: string; criterion: string; learnerGroup: string; conditions?: string; method: string; task?: string },
) {
  return observationCriteria.every((key) => normalizeObservationText(left[key]) === normalizeObservationText(right[key]));
}
