-- Partial expression index on audit_log.details->extractionId for share-related actions.
-- Speeds up GET /api/extractions/:id/access-log by orders of magnitude.
-- Partial index keeps the index small: only share_* rows are indexed, login/export/etc.
-- audit entries (which never carry an extractionId) stay out of the index.
CREATE INDEX IF NOT EXISTS idx_audit_share_extraction
  ON audit_log(json_extract(details, '$.extractionId'))
  WHERE action IN ('share_read', 'share_edit', 'share_granted', 'share_revoked');
