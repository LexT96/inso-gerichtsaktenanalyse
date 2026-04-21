-- Async-job state for supplemental document extraction.
-- The extract pipeline now runs OCR + focused passes + handwriting,
-- so it can take >60s and must run in the background.
ALTER TABLE documents ADD COLUMN job_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE documents ADD COLUMN job_progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN job_message TEXT;
ALTER TABLE documents ADD COLUMN job_diff_json TEXT;
ALTER TABLE documents ADD COLUMN job_error TEXT;
ALTER TABLE documents ADD COLUMN job_started_at TEXT;
ALTER TABLE documents ADD COLUMN job_finished_at TEXT;
CREATE INDEX IF NOT EXISTS idx_documents_job_status ON documents(job_status);
