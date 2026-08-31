CREATE TABLE IF NOT EXISTS bulk_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
  operation TEXT NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued',
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  current_item JSONB,
  failed_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retention_until TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days'
);

CREATE TABLE IF NOT EXISTS bulk_operation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES bulk_operations(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  item JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  processed_at TIMESTAMPTZ,
  UNIQUE (operation_id, item_index)
);

CREATE INDEX IF NOT EXISTS bulk_operations_retention_idx ON bulk_operations(retention_until);
CREATE INDEX IF NOT EXISTS bulk_operation_items_pending_idx ON bulk_operation_items(operation_id, item_index) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION cleanup_expired_bulk_operations()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE deleted_count INTEGER;
BEGIN
  DELETE FROM bulk_operations WHERE retention_until < now();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;