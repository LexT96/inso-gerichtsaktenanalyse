-- Add 'expired' and 'deleted_art17' to extraction status values.
-- SQLite doesn't support ALTER CHECK, so we recreate the table.

CREATE TABLE extractions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  result_json TEXT,
  status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing', 'completed', 'failed', 'expired', 'deleted_art17')),
  error_message TEXT,
  stats_found INTEGER DEFAULT 0,
  stats_missing INTEGER DEFAULT 0,
  stats_letters_ready INTEGER DEFAULT 0,
  processing_time_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO extractions_new SELECT * FROM extractions;

DROP TABLE extractions;

ALTER TABLE extractions_new RENAME TO extractions;

CREATE INDEX IF NOT EXISTS idx_extractions_user ON extractions(user_id);
