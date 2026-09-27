import { z } from "zod";

const nonPlaceholder = (value: string) => !/^(待填写|unknown|todo)$/i.test(value.trim());

const standardDocumentSchema = z.object({
  filename: z.string().trim().min(5).refine((value) => value.toLowerCase().endsWith(".pdf"), "standard_pdf_required"),
  title: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  stageScope: z.array(z.string().trim().min(1)).min(1).max(8),
  gradeScope: z.array(z.string().trim().min(1)).max(20).default([]),
  standardCode: z.string().trim().max(120).default(""),
  sourceUrl: z.union([z.url(), z.literal("")]).default(""),
});

export const curriculumStandardManifestSchema = z.object({
  schemaVersion: z.literal(1),
  release: z.object({
    seriesKey: z.string().trim().min(3).max(120).regex(/^[a-z0-9][a-z0-9._-]+$/),
    releaseKey: z.string().trim().min(3).max(160).regex(/^[a-z0-9][a-z0-9._-]+$/),
    title: z.string().trim().min(1).max(300),
    versionLabel: z.string().trim().min(1).max(120),
    authority: z.string().trim().min(1).max(200),
    issuedYear: z.number().int().min(1900).max(2200).nullable().optional(),
  }),
  documents: z.array(standardDocumentSchema).min(1).max(64),
}).superRefine((manifest, context) => {
  for (const field of ["title", "versionLabel", "authority"] as const) {
    if (!nonPlaceholder(manifest.release[field])) {
      context.addIssue({ code: "custom", path: ["release", field], message: "standard_release_metadata_incomplete" });
    }
  }
  const filenames = new Set<string>();
  for (const [index, document] of manifest.documents.entries()) {
    const normalized = document.filename.normalize("NFKC");
    if (normalized.includes("/") || normalized.includes("\\") || normalized === "." || normalized === "..") {
      context.addIssue({ code: "custom", path: ["documents", index, "filename"], message: "standard_filename_invalid" });
    }
    if (filenames.has(normalized)) {
      context.addIssue({ code: "custom", path: ["documents", index, "filename"], message: "standard_filename_duplicate" });
    }
    filenames.add(normalized);
    for (const field of ["title", "subject"] as const) {
      if (!nonPlaceholder(document[field])) {
        context.addIssue({ code: "custom", path: ["documents", index, field], message: "standard_metadata_incomplete" });
      }
    }
    if (document.stageScope.some((stage) => !nonPlaceholder(stage))) {
      context.addIssue({ code: "custom", path: ["documents", index, "stageScope"], message: "standard_metadata_incomplete" });
    }
    if (new Set(document.stageScope).size !== document.stageScope.length) {
      context.addIssue({ code: "custom", path: ["documents", index, "stageScope"], message: "standard_stage_duplicate" });
    }
    if (new Set(document.gradeScope).size !== document.gradeScope.length) {
      context.addIssue({ code: "custom", path: ["documents", index, "gradeScope"], message: "standard_grade_duplicate" });
    }
  }
});

export type CurriculumStandardManifest = z.infer<typeof curriculumStandardManifestSchema>;

export function parseCurriculumStandardManifest(value: unknown) {
  return curriculumStandardManifestSchema.parse(value);
}
