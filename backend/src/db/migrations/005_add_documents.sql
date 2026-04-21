-- Track multiple documents per extraction (Gerichtsakte + supplements).
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  extraction_id INTEGER NOT NULL REFERENCES extractions(id) ON DELETE CASCADE,
  doc_index INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  pdf_hash TEXT,
  uploaded_at TEXT DEFAULT (datetime('now')),
  UNIQUE(extraction_id, doc_index)
);
