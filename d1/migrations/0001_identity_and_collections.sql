-- Portable SQLite subset. Do not use D1 PRAGMAs, FTS, triggers, generated
-- columns, or SQLite date/JSON functions in migrations consumed by the app.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login_name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_active_idx ON auth_sessions(token_hash, expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  class_name TEXT NOT NULL,
  year TEXT NOT NULL,
  subject TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  edition TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (tone IN ('teal', 'sage', 'amber', 'coral'))
);

CREATE INDEX IF NOT EXISTS notebooks_owner_updated_idx ON notebooks(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS lesson_files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  notebook_id TEXT NOT NULL,
  lesson_blueprint_id TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  image TEXT,
  document_json TEXT NOT NULL,
  context_profile_json TEXT NOT NULL,
  document_version INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  CHECK (document_version >= 0),
  CHECK (page_count > 0)
);

CREATE INDEX IF NOT EXISTS lesson_files_owner_notebook_updated_idx
  ON lesson_files(owner_id, notebook_id, updated_at DESC);
