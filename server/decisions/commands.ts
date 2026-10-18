import { z } from "zod";
import { lessonFieldSchema } from "../domain.js";
import { observationPlanSchema } from "../learning/observation-plan.js";
import { DECISION_EVENT_TYPES, DECISION_TYPES, EVIDENCE_KINDS, EVIDENCE_LEVELS } from "./contracts.js";

const text = (max = 2_000) => z.string().trim().min(1).max(max);
const optionalText = (max = 2_000) => z.string().trim().max(max).optional();
const uuid = z.string().uuid();
const contextVersion = z.object({ documentVersion: z.number().int().nonnegative(), frameworkVersion: z.number().int().nonnegative().nullable().default(null) }).strict();
const options = z.array(z.object({ id: text(64), statement: text(2_000), tradeoffs: z.array(text(1_000)).min(1).max(6) }).strict()).max(6);
const statements = z.array(text(2_000)).max(8);

/** The teacher selects the source; ownership, quotation and metadata are bound by the server. */
export const lessonDecisionEvidenceSchema = z.object({
  field: lessonFieldSchema, excerpt: text(4_000), claim: text(1_000), applicability: text(1_000),
  limitations: z.array(text(1_000)).min(1).max(8),
}).strict();

export const decisionEvidenceInputSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS), level: z.enum(EVIDENCE_LEVELS),
  source: z.object({ system: text(100), uri: text(2_000), locator: z.string().trim().max(500).nullable(), version: text(100), capturedAt: z.iso.datetime() }).strict(),
  excerpt: text(4_000), claim: text(1_000), supports: z.array(text(64)).max(8).default([]),
  applicability: text(1_000), limitations: z.array(text(1_000)).min(1).max(8), conflictsWith: z.array(text(64)).max(8).default([]),
  confidence: z.number().min(0).max(1).nullable().default(null), expiresAt: z.iso.datetime().nullable().default(null),
  piiLevel: z.enum(["none", "teacher", "student"]).default("none"),
}).strict();

export const proposeDecisionSchema = z.object({
  contextVersion, decisionType: z.enum(DECISION_TYPES), question: text(1_000),
  options: options.default([]),
  chosenOptionId: z.string().trim().min(1).max(64).nullable().default(null)
    .describe("Copy exactly one options[].id, such as opt_b. Do not use an option label, statement, or the string 'null'. If no option is chosen, send JSON null."),
  rationale: text(4_000), counterevidence: statements.default([]), assumptions: statements.default([]), uncertainties: statements.default([]),
  confidence: z.number().min(0).max(1).nullable().default(null),
  expectedSignal: z.string().trim().max(2_000).default(""), falsifier: z.string().trim().max(2_000).default(""),
  observationPlan: observationPlanSchema.nullable().optional()
    .describe("For an actionable candidate, provide the actual check task and criterion. A design_check inspects the lesson itself with document_check, never uses student attainment as proof that the old assessment covered the goal. A learning_change needs comparable baseline and later observations; leave baselineEvidenceId null when none is available."),
  reviewAt: z.iso.datetime().nullable().default(null), evidenceCards: z.array(decisionEvidenceInputSchema).max(8).default([]),
  lessonEvidence: z.array(lessonDecisionEvidenceSchema).max(8).optional(),
  status: z.enum(["draft", "proposed", "insufficient_evidence"]).default("proposed"),
  createdBy: z.enum(["agent", "teacher"]).default("teacher"), sourceRunId: z.string().trim().min(1).max(200).optional(),
}).strict();
export type ProposeDecisionInput = z.infer<typeof proposeDecisionSchema>;

export const decisionActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("confirm"), expectedVersion: z.number().int().nonnegative(), chosenOptionId: text(64),
    rationale: optionalText(4_000), confidence: z.number().min(0).max(1).optional(),
    expectedSignal: optionalText(2_000), falsifier: optionalText(2_000),
    assumptions: statements.optional(), uncertainties: statements.optional(), observationPlan: observationPlanSchema.optional(),
  }).strict(),
  z.object({
    action: z.literal("revise"), expectedVersion: z.number().int().nonnegative(), contextVersion,
    question: text(1_000).optional(), decisionType: z.enum(DECISION_TYPES).optional(), options: options.optional(),
    rationale: text(4_000).optional(), counterevidence: statements.optional(), assumptions: statements.optional(), uncertainties: statements.optional(),
    confidence: z.number().min(0).max(1).nullable().optional(), expectedSignal: optionalText(2_000), falsifier: optionalText(2_000),
    observationPlan: observationPlanSchema.nullable().optional(), lessonEvidence: z.array(lessonDecisionEvidenceSchema).max(8).optional(),
    status: z.enum(["draft", "proposed", "insufficient_evidence"]).optional(),
  }).strict(),
  z.object({ action: z.literal("reject"), expectedVersion: z.number().int().nonnegative(), reasonCode: z.enum(["insufficient_evidence", "not_applicable", "student_mismatch", "other"]), rationale: text(4_000) }).strict(),
  z.object({ action: z.literal("no_change"), expectedVersion: z.number().int().nonnegative(), rationale: text(4_000), confidence: z.number().min(0).max(1).optional() }).strict(),
  z.object({ action: z.literal("implement"), expectedVersion: z.number().int().nonnegative(), implementedAt: z.iso.datetime().optional(), note: z.string().trim().max(2_000).default(""), baselineEvidenceId: uuid.nullable().optional() }).strict(),
  z.object({ action: z.literal("review"), expectedVersion: z.number().int().nonnegative(), outcome: z.enum(["supported", "not_supported", "inconclusive"]), rationale: text(4_000), limitations: text(2_000), evidenceIds: z.array(uuid).min(1).max(8) }).strict(),
  z.object({ action: z.literal("supersede"), expectedVersion: z.number().int().nonnegative(), rationale: text(2_000) }).strict(),
]);
export type DecisionActionInput = z.infer<typeof decisionActionSchema>;

export const decisionEventInputSchema = z.object({
  type: z.enum(DECISION_EVENT_TYPES), decisionId: uuid.optional(), decisionType: z.enum(DECISION_TYPES).optional(), evidenceId: uuid.optional(),
  durationMs: z.number().int().min(0).max(600_000).optional(), count: z.number().int().min(0).max(1_000).optional(),
}).strict();
export type DecisionEventInput = z.infer<typeof decisionEventInputSchema>;
export const decisionReadQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.object({ at: z.iso.datetime(), id: z.string().uuid() }).strict().optional(),
}).strict();
export type DecisionReadQuery = z.infer<typeof decisionReadQuerySchema>;
