-- A lesson file is a durable aggregate. Older D1 writes created only the
-- document row, leaving Pi without the version-zero snapshot and design basis
-- it requires to construct a verified lesson context. Backfill the canonical
-- current snapshot and a minimal basis for those historical rows. New writes
-- create the same records atomically in D1LessonWorkspaceStore.

INSERT INTO lesson_file_versions (
  id, owner_id, lesson_file_id, document_version, document_json, page_count,
  actor, run_id, idempotency_key, created_at
)
SELECT
  'initial-file:' || file.id,
  file.owner_id,
  file.id,
  file.document_version,
  file.document_json,
  file.page_count,
  'import',
  NULL,
  'initial-file:' || file.id,
  file.updated_at
FROM lesson_files AS file
WHERE NOT EXISTS (
  SELECT 1
  FROM lesson_file_versions AS version
  WHERE version.owner_id = file.owner_id
    AND version.lesson_file_id = file.id
    AND version.document_version = file.document_version
);

INSERT INTO lesson_design_bases (
  id, owner_id, notebook_id, lesson_file_id, framework_id, semester_unit_id,
  lesson_blueprint_id, catalog_release_id, textbook_id, curriculum_node_id,
  semantic_release_id, source_framework_version, source_blueprint_version,
  learner_context_json, teacher_notes, status, version, created_at, updated_at
)
SELECT
  'basis:' || file.id,
  file.owner_id,
  file.notebook_id,
  file.id,
  framework.id,
  blueprint.semester_unit_id,
  blueprint.id,
  framework.catalog_release_id,
  framework.textbook_id,
  blueprint.curriculum_node_id,
  framework.semantic_release_id,
  framework.version,
  blueprint.version,
  file.context_profile_json,
  '',
  'draft',
  0,
  file.updated_at,
  file.updated_at
FROM lesson_files AS file
LEFT JOIN lesson_blueprints AS blueprint
  ON blueprint.owner_id = file.owner_id
  AND blueprint.id = file.lesson_blueprint_id
LEFT JOIN semester_frameworks AS framework
  ON framework.owner_id = blueprint.owner_id
  AND framework.id = blueprint.framework_id
WHERE NOT EXISTS (
  SELECT 1
  FROM lesson_design_bases AS basis
  WHERE basis.owner_id = file.owner_id
    AND basis.lesson_file_id = file.id
);
