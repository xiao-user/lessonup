import type { LessonContextProfile } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import { formatTextbookEditionLabel } from "./catalog.js";

const normalize = (value: string) => value.trim().toLocaleLowerCase("zh-CN");

export async function canonicalizeLessonContextProfile(args: {
  repository: LessonRepository;
  subject: string;
  stage?: string;
  grade?: string;
  edition?: string;
  profile: LessonContextProfile;
}): Promise<LessonContextProfile> {
  const profile = { ...args.profile };
  if (!profile.textbookId) {
    if (profile.unitNodeId || profile.lessonNodeId) {
      throw new Error("curriculum_node_requires_textbook");
    }
    return profile;
  }

  const book = await args.repository.getCurriculumTextbook(profile.textbookId);
  if (!book) throw new Error("curriculum_textbook_not_found");
  if (normalize(book.subject) !== normalize(args.subject)) {
    throw new Error("curriculum_subject_mismatch");
  }
  if (args.stage && normalize(book.stage) !== normalize(args.stage)) {
    throw new Error("curriculum_stage_mismatch");
  }
  if (args.grade && normalize(book.grade) !== normalize(args.grade)) {
    throw new Error("curriculum_grade_mismatch");
  }
  if (args.edition && normalize(book.edition) !== normalize(args.edition)) {
    throw new Error("curriculum_edition_mismatch");
  }
  if (profile.unitNodeId || profile.lessonNodeId) {
    const nodes = await args.repository.listCurriculumNodes({
      textbookId: book.id,
      maxLevel: 8,
    });
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const unit = profile.unitNodeId ? byId.get(profile.unitNodeId) : undefined;
    if (profile.unitNodeId && !unit) {
      throw new Error("curriculum_unit_not_in_textbook");
    }
    if (unit && unit.parentId !== null) {
      throw new Error("curriculum_unit_not_root");
    }
    if (profile.lessonNodeId) {
      if (!unit) throw new Error("curriculum_lesson_requires_unit");
      let node = byId.get(profile.lessonNodeId);
      if (!node) throw new Error("curriculum_lesson_not_in_textbook");
      const visited = new Set<string>();
      while (node && node.parentId !== unit.nodeId && !visited.has(node.nodeId)) {
        visited.add(node.nodeId);
        node = node.parentId ? byId.get(node.parentId) : undefined;
      }
      if (!node || node.parentId !== unit.nodeId) {
        throw new Error("curriculum_lesson_not_in_unit");
      }
    }
  }
  return {
    ...profile,
    gradeLevel: book.grade || undefined,
    textbookEdition: formatTextbookEditionLabel(book) || book.title,
    textbookId: book.id,
  };
}
