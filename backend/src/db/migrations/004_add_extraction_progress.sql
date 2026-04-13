-- Add progress tracking columns for extractions.
-- Allows frontend to poll progress after page reload.
ALTER TABLE extractions ADD COLUMN progress_message TEXT;
ALTER TABLE extractions ADD COLUMN progress_percent INTEGER DEFAULT 0;
