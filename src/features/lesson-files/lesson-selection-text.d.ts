import type { Marked } from "marked";
export type LessonHighlightTone = "yellow" | "pink" | "green" | "blue" | "red";
export const lessonHighlightTones: LessonHighlightTone[];
export function createLessonMarkdownParser(): Marked;
export function tokenizeLessonHighlight(source: string, inlineTokens: (text: string) => unknown[]): {
  type: string; raw: string; text: string; tone: string; tokens: unknown[];
} | undefined;
export function getLessonHighlightSpans(source: unknown): Array<{text: string; tone: LessonHighlightTone}>;
export function lessonSelectionPlainText(source: unknown): string;
export function normalizeLessonSelectionText(value: unknown): string;
export function lessonSelectionMatches(source: unknown, quote: unknown): boolean;
