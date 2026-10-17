-- Bounded predecessor reads must seek by owner and blueprint before sorting.
CREATE INDEX IF NOT EXISTS lesson_class_feedback_blueprint_idx
  ON lesson_class_feedback(owner_id, lesson_blueprint_id, created_at DESC, id DESC);
