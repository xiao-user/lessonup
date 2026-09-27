import { z } from "zod";

export const dashiThemeSchema = z.enum([
  "theme01", "theme02", "theme03", "theme04", "theme05", "theme06",
  "theme07", "theme08", "theme09", "theme10", "theme11", "theme12",
]);

export const dashiJsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(dashiJsonValueSchema),
  z.record(z.string(), dashiJsonValueSchema),
]));

/**
 * This is Dashi's native goal.json shape. LessonUp stores it only so an
 * existing generated deck can be identified; the Agent writes it according to
 * the installed Dashi Skill and LessonUp never derives a second slide model.
 */
export const dashiGoalSchema = z.object({
  title: z.string().trim().min(1).max(240),
  goal: z.string().trim().min(1).max(2_000),
  audience: z.string().trim().max(500).optional(),
  owner: z.string().trim().max(500).optional(),
  language: z.string().trim().max(24).optional(),
  randomSeed: z.string().trim().max(160).optional(),
  pageCount: z.number().int().positive().max(40).optional(),
  themePack: dashiThemeSchema,
  preview: z.object({ themeSwitcher: z.boolean().optional() }).strict().optional(),
  slides: z.array(z.object({
    layout: z.string().regex(/^theme(?:0[1-9]|1[0-2])_page\d{3}$/),
    props: z.record(z.string(), dashiJsonValueSchema),
  }).strict()).min(1).max(40),
}).strict().superRefine((goal, context) => {
  if (goal.pageCount !== undefined && goal.pageCount !== goal.slides.length) {
    context.addIssue({
      code: "custom",
      path: ["pageCount"],
      message: "page_count_must_match_slides",
    });
  }
  for (const [index, slide] of goal.slides.entries()) {
    if (!slide.layout.startsWith(`${goal.themePack}_`)) {
      context.addIssue({
        code: "custom",
        path: ["slides", index, "layout"],
        message: "layout_theme_mismatch",
      });
    }
  }
});

export type DashiGoal = z.infer<typeof dashiGoalSchema>;
