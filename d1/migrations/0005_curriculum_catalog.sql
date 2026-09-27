-- Current published textbook catalog. Importers own release creation and data
-- loading; application reads remain portable SQL plus application-side tree
-- and search helpers.
CREATE TABLE IF NOT EXISTS curriculum_catalog_releases (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  snapshot_complete INTEGER NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  textbook_count INTEGER NOT NULL DEFAULT 0,
  node_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  published_at TEXT,
  retired_at TEXT,
  CHECK (status IN ('draft', 'published', 'retired')),
  CHECK (snapshot_complete IN (0, 1))
);
CREATE TABLE IF NOT EXISTS curriculum_catalog_current (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  catalog_release_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (catalog_release_id) REFERENCES curriculum_catalog_releases(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS curriculum_textbooks (
  id TEXT PRIMARY KEY,
  catalog_release_id TEXT NOT NULL,
  title TEXT NOT NULL,
  stage TEXT NOT NULL,
  subject TEXT NOT NULL,
  edition TEXT NOT NULL,
  grade TEXT NOT NULL,
  volume TEXT NOT NULL DEFAULT '',
  publisher_id TEXT NOT NULL DEFAULT '',
  ebook_id TEXT,
  detail_url TEXT,
  tree_url TEXT,
  source_pdf_url TEXT,
  source_list_url TEXT,
  node_count INTEGER NOT NULL DEFAULT 0,
  source_updated_at TEXT,
  FOREIGN KEY (catalog_release_id) REFERENCES curriculum_catalog_releases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS curriculum_textbooks_filter_idx ON curriculum_textbooks(catalog_release_id, stage, subject, edition, grade);
CREATE TABLE IF NOT EXISTS curriculum_nodes (
  catalog_release_id TEXT NOT NULL,
  textbook_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  parent_id TEXT,
  level INTEGER NOT NULL,
  sort_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  page_number INTEGER,
  PRIMARY KEY (catalog_release_id, textbook_id, node_id),
  FOREIGN KEY (catalog_release_id) REFERENCES curriculum_catalog_releases(id) ON DELETE CASCADE,
  FOREIGN KEY (textbook_id) REFERENCES curriculum_textbooks(id) ON DELETE CASCADE,
  CHECK (level > 0), CHECK (sort_no >= 0)
);
CREATE INDEX IF NOT EXISTS curriculum_nodes_outline_idx ON curriculum_nodes(catalog_release_id, textbook_id, level, sort_no);
