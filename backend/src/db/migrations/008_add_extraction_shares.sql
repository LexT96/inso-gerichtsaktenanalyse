CREATE TABLE IF NOT EXISTS extraction_shares (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  extraction_id INTEGER NOT NULL REFERENCES extractions(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  granted_by    INTEGER NOT NULL REFERENCES users(id),
  granted_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(extraction_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_extraction_shares_user
  ON extraction_shares(user_id);
CREATE INDEX IF NOT EXISTS idx_extraction_shares_extraction
  ON extraction_shares(extraction_id);
