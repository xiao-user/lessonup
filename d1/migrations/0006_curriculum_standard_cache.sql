CREATE TABLE IF NOT EXISTS curriculum_standard_query_cache (
  context_fingerprint TEXT NOT NULL,
  query_sha256 TEXT NOT NULL,
  result_limit INTEGER NOT NULL,
  results_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (context_fingerprint, query_sha256, result_limit),
  CHECK (result_limit > 0)
);
