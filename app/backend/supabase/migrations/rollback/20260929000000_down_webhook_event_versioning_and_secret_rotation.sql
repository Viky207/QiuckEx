-- Rollback for: 20260929000000_webhook_event_versioning_and_secret_rotation.sql
--
-- Drops the version pin and the rotation overlap columns. Deliveries revert to
-- the default API version, and any in-flight overlap is lost: subscribers
-- mid-rotation must redeploy against the current secret after this runs.

DROP INDEX IF EXISTS notification_preferences_webhook_api_version_idx;

ALTER TABLE notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_webhook_api_version_check;

ALTER TABLE notification_preferences
  DROP COLUMN IF EXISTS webhook_previous_secret_expires_at,
  DROP COLUMN IF EXISTS webhook_previous_secret,
  DROP COLUMN IF EXISTS webhook_api_version;

DROP INDEX IF EXISTS notification_log_dlq_quarantined_idx;

ALTER TABLE notification_log
  DROP COLUMN IF EXISTS quarantined_at,
  DROP COLUMN IF EXISTS dlq_reason;

