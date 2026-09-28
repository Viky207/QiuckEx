-- Issues #275 / #277: versioned webhook events and secret-rotation overlap.
--
-- webhook_api_version pins a subscriber to a webhook API version. NULL means
-- "use the default", which keeps existing rows on the default version and makes
-- this migration backward compatible for live subscribers — no backfill is
-- required and no delivery changes shape for current endpoints.
--
-- webhook_previous_secret / webhook_previous_secret_expires_at implement a
-- bounded rotation overlap: the previous secret is retained only for
-- verification, only until the expiry, and is never used for signing. Both are
-- NULL once the overlap closes.

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS webhook_api_version TEXT,
  ADD COLUMN IF NOT EXISTS webhook_previous_secret TEXT,
  ADD COLUMN IF NOT EXISTS webhook_previous_secret_expires_at TIMESTAMPTZ;

ALTER TABLE notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_webhook_api_version_check;

ALTER TABLE notification_preferences
  ADD CONSTRAINT notification_preferences_webhook_api_version_check
  CHECK (webhook_api_version IS NULL OR webhook_api_version IN ('v1', 'v2'));

COMMENT ON COLUMN notification_preferences.webhook_api_version IS
  'Pinned webhook API version for this subscriber (v1 | v2). NULL = default version.';

COMMENT ON COLUMN notification_preferences.webhook_previous_secret IS
  'Previous signing secret retained for verification during a rotation overlap window. Never used for signing.';

COMMENT ON COLUMN notification_preferences.webhook_previous_secret_expires_at IS
  'Instant after which webhook_previous_secret is no longer accepted for verification.';

-- Lets an operator answer "which version is this endpoint on, and is it
-- behind?" without a table scan, and find subscribers still on a deprecated
-- version before its sunset.
CREATE INDEX IF NOT EXISTS notification_preferences_webhook_api_version_idx
  ON notification_preferences (webhook_api_version)
  WHERE channel = 'webhook';

-- Issue #276: quarantine metadata.
--
-- A quarantined delivery is one that will not be retried automatically. The
-- reason is a stable enum-ish string (ATTEMPTS_EXHAUSTED, PERMANENT_CLIENT_ERROR,
-- ORDERING_BLOCK_TIMEOUT, MANUAL) so operators and alerts can group on it, and
-- the timestamp records when the entry was parked.
--
-- Both columns are nullable and default to NULL, so existing rows keep working
-- and only newly quarantined deliveries carry a reason.
ALTER TABLE notification_log
  ADD COLUMN IF NOT EXISTS dlq_reason TEXT,
  ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ;

COMMENT ON COLUMN notification_log.dlq_reason IS
  'Stable reason a webhook delivery was quarantined (ATTEMPTS_EXHAUSTED | PERMANENT_CLIENT_ERROR | ORDERING_BLOCK_TIMEOUT | MANUAL).';

COMMENT ON COLUMN notification_log.quarantined_at IS
  'Instant a webhook delivery was moved to the dead-letter state. NULL while the delivery is still retryable.';

-- Supports the dead-letter listing endpoint, which filters by status and orders
-- by when the entry was parked.
CREATE INDEX IF NOT EXISTS notification_log_dlq_quarantined_idx
  ON notification_log (quarantined_at DESC)
  WHERE channel = 'webhook' AND status = 'dlq';

