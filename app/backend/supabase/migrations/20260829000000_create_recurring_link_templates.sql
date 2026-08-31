-- =============================================================================
-- Recurring Link Templates Engine Tables
-- =============================================================================
-- Support for templated recurring payment links with variable substitution
-- and cron-based scheduling with timezone support
-- =============================================================================

-- ---------------------------------------------------------------------------
-- recurring_link_templates
-- ---------------------------------------------------------------------------
-- Base template definition for recurring payment link generation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recurring_link_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Template identification
  name TEXT NOT NULL, -- Human-readable template name
  description TEXT, -- Optional description of what this template does
  
  -- Template configuration
  asset TEXT NOT NULL, -- Asset code (XLM, USDC, etc.)
  asset_issuer TEXT, -- Issuer address for non-native assets
  amount DECIMAL(17,7) NOT NULL, -- Default amount (can be overridden by variables)
  
  -- Schedule configuration with timezone support
  cron_expression TEXT NOT NULL, -- Cron expression for scheduling
  timezone TEXT NOT NULL DEFAULT 'UTC', -- IANA timezone identifier
  
  -- Variables definition (JSON array of variable names)
  variables JSONB NOT NULL DEFAULT '[]', -- e.g. ["amount", "memo", "invoice_id"]
  
  -- Template metadata
  created_by TEXT NOT NULL, -- User/API that created this template
  organization_id TEXT, -- Optional organization context
  
  -- Status management
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Constraints
  CONSTRAINT recurring_link_templates_amount_positive CHECK (amount > 0),
  CONSTRAINT recurring_link_templates_name_not_empty CHECK (length(trim(name)) > 0),
  CONSTRAINT recurring_link_templates_cron_not_empty CHECK (length(trim(cron_expression)) > 0),
  CONSTRAINT recurring_link_templates_timezone_not_empty CHECK (length(trim(timezone)) > 0)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS recurring_link_templates_name_idx ON recurring_link_templates (name);
CREATE INDEX IF NOT EXISTS recurring_link_templates_status_idx ON recurring_link_templates (status);
CREATE INDEX IF NOT EXISTS recurring_link_templates_created_by_idx ON recurring_link_templates (created_by);
CREATE INDEX IF NOT EXISTS recurring_link_templates_organization_idx ON recurring_link_templates (organization_id);
CREATE INDEX IF NOT EXISTS recurring_link_templates_asset_idx ON recurring_link_templates (asset);

COMMENT ON TABLE recurring_link_templates IS 'Template definitions for recurring payment link generation';
COMMENT ON COLUMN recurring_link_templates.name IS 'Human-readable template name';
COMMENT ON COLUMN recurring_link_templates.cron_expression IS 'Cron expression for scheduling (supports standard 5-field format)';
COMMENT ON COLUMN recurring_link_templates.timezone IS 'IANA timezone identifier for cron execution';
COMMENT ON COLUMN recurring_link_templates.variables IS 'JSON array of variable names used in templates';
COMMENT ON COLUMN recurring_link_templates.status IS 'Template status: active, inactive, archived';

-- ---------------------------------------------------------------------------
-- recurring_link_template_versions
-- ---------------------------------------------------------------------------
-- Versioned template content with variable substitution templates
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recurring_link_template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Template reference
  template_id UUID NOT NULL REFERENCES recurring_link_templates(id) ON DELETE CASCADE,
  
  -- Version management
  version_number INTEGER NOT NULL, -- Incremental version number per template
  
  -- Template content with variable placeholders
  username_template TEXT, -- Template for username with {{variables}} (nullable for direct destination)
  destination_template TEXT, -- Template for destination with {{variables}} (nullable for username)
  amount_template TEXT NOT NULL, -- Template for amount (can be static or use {{amount}} variable)
  memo_template TEXT, -- Template for memo with {{variables}}
  reference_id_template TEXT, -- Template for reference_id with {{variables}}
  
  -- Recurring configuration templates
  frequency_template TEXT NOT NULL DEFAULT 'monthly', -- Template for frequency
  start_date_template TEXT, -- Template for start_date (can use variables for dynamic dates)
  end_date_template TEXT, -- Template for end_date (can use variables for dynamic dates)
  total_periods_template TEXT, -- Template for total_periods (can use variables)
  
  -- Template metadata
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  change_notes TEXT, -- Description of changes in this version
  created_by TEXT NOT NULL, -- User/API that created this version
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Constraints
  CONSTRAINT recurring_link_template_versions_either_username_or_destination 
    CHECK (username_template IS NOT NULL OR destination_template IS NOT NULL),
  CONSTRAINT recurring_link_template_versions_version_positive CHECK (version_number > 0),
  CONSTRAINT recurring_link_template_versions_frequency_valid 
    CHECK (frequency_template IN ('daily', 'weekly', 'monthly', 'yearly') 
           OR frequency_template LIKE '%{{%}}%'), -- Allow templates with variables
  -- Only one active version per template
  CONSTRAINT recurring_link_template_versions_active_unique 
    UNIQUE (template_id, status) DEFERRABLE INITIALLY DEFERRED,
  -- Version numbers are unique per template
  CONSTRAINT recurring_link_template_versions_version_unique 
    UNIQUE (template_id, version_number)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS recurring_link_template_versions_template_id_idx ON recurring_link_template_versions (template_id);
CREATE INDEX IF NOT EXISTS recurring_link_template_versions_status_idx ON recurring_link_template_versions (status);
CREATE INDEX IF NOT EXISTS recurring_link_template_versions_version_number_idx ON recurring_link_template_versions (version_number);
CREATE INDEX IF NOT EXISTS recurring_link_template_versions_created_by_idx ON recurring_link_template_versions (created_by);

COMMENT ON TABLE recurring_link_template_versions IS 'Versioned template content with variable substitution templates';
COMMENT ON COLUMN recurring_link_template_versions.username_template IS 'Username template with {{variables}} (e.g., "user-{{invoice_id}}")';
COMMENT ON COLUMN recurring_link_template_versions.destination_template IS 'Destination template with {{variables}}';
COMMENT ON COLUMN recurring_link_template_versions.amount_template IS 'Amount template (e.g., "{{amount}}" or static value)';
COMMENT ON COLUMN recurring_link_template_versions.memo_template IS 'Memo template with {{variables}} (e.g., "Invoice {{invoice_id}}")';
COMMENT ON COLUMN recurring_link_template_versions.status IS 'Version status: draft, active, archived';

-- ---------------------------------------------------------------------------
-- recurring_link_template_executions
-- ---------------------------------------------------------------------------
-- Tracks template-based recurring link generation executions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recurring_link_template_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Template reference
  template_id UUID NOT NULL REFERENCES recurring_link_templates(id) ON DELETE CASCADE,
  template_version_id UUID NOT NULL REFERENCES recurring_link_template_versions(id),
  
  -- Execution details
  scheduled_at TIMESTAMPTZ NOT NULL, -- When this execution was scheduled
  executed_at TIMESTAMPTZ, -- When this execution actually ran
  
  -- Variable data used for this execution (JSON object)
  variable_data JSONB NOT NULL DEFAULT '{}', -- e.g. {"amount": "100", "memo": "Invoice #123", "invoice_id": "INV-123"}
  
  -- Generated recurring link reference
  recurring_link_id UUID REFERENCES recurring_payment_links(id), -- Link to generated recurring payment link
  
  -- Execution status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'skipped')),
  
  -- Error handling
  error_message TEXT, -- Error details if execution failed
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_retry_at TIMESTAMPTZ,
  
  -- Job reference for background processing
  job_id UUID, -- Reference to job queue entry
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Constraints
  CONSTRAINT recurring_link_template_executions_retry_non_negative CHECK (retry_count >= 0)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS recurring_link_template_executions_template_id_idx ON recurring_link_template_executions (template_id);
CREATE INDEX IF NOT EXISTS recurring_link_template_executions_status_idx ON recurring_link_template_executions (status);
CREATE INDEX IF NOT EXISTS recurring_link_template_executions_scheduled_at_idx ON recurring_link_template_executions (scheduled_at);
CREATE INDEX IF NOT EXISTS recurring_link_template_executions_recurring_link_idx ON recurring_link_template_executions (recurring_link_id);
CREATE INDEX IF NOT EXISTS recurring_link_template_executions_job_id_idx ON recurring_link_template_executions (job_id);

-- Composite index for scheduler queries
CREATE INDEX IF NOT EXISTS recurring_link_template_executions_pending_schedule_idx 
  ON recurring_link_template_executions (status, scheduled_at) 
  WHERE status = 'pending';

COMMENT ON TABLE recurring_link_template_executions IS 'Execution records for template-based recurring link generation';
COMMENT ON COLUMN recurring_link_template_executions.variable_data IS 'JSON object containing variable values used for this execution';
COMMENT ON COLUMN recurring_link_template_executions.recurring_link_id IS 'Reference to the generated recurring payment link';
COMMENT ON COLUMN recurring_link_template_executions.status IS 'Execution status: pending, success, failed, skipped';

-- ---------------------------------------------------------------------------
-- Add preview scope support to template tables
-- ---------------------------------------------------------------------------

-- Add preview scope to templates for branch-based testing
ALTER TABLE recurring_link_templates
  ADD COLUMN IF NOT EXISTS preview_scope TEXT;

ALTER TABLE recurring_link_template_versions
  ADD COLUMN IF NOT EXISTS preview_scope TEXT;

ALTER TABLE recurring_link_template_executions
  ADD COLUMN IF NOT EXISTS preview_scope TEXT;

-- Indexes for preview scope
CREATE INDEX IF NOT EXISTS recurring_link_templates_preview_scope_idx ON recurring_link_templates (preview_scope);
CREATE INDEX IF NOT EXISTS recurring_link_template_versions_preview_scope_idx ON recurring_link_template_versions (preview_scope);
CREATE INDEX IF NOT EXISTS recurring_link_template_executions_preview_scope_idx ON recurring_link_template_executions (preview_scope);

COMMENT ON COLUMN recurring_link_templates.preview_scope IS 'Optional preview scope for branch-based testing';
COMMENT ON COLUMN recurring_link_template_versions.preview_scope IS 'Optional preview scope for branch-based testing';
COMMENT ON COLUMN recurring_link_template_executions.preview_scope IS 'Optional preview scope for branch-based testing';

-- ---------------------------------------------------------------------------
-- Triggers for updated_at timestamps
-- ---------------------------------------------------------------------------

-- Trigger to update updated_at timestamp for templates
CREATE OR REPLACE FUNCTION update_recurring_link_template_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER recurring_link_templates_updated_at_trigger
  BEFORE UPDATE ON recurring_link_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_recurring_link_template_updated_at();

CREATE TRIGGER recurring_link_template_versions_updated_at_trigger
  BEFORE UPDATE ON recurring_link_template_versions
  FOR EACH ROW
  EXECUTE FUNCTION update_recurring_link_template_updated_at();

-- ---------------------------------------------------------------------------
-- Helper functions for template processing
-- ---------------------------------------------------------------------------

-- Function to render template with variable substitution
CREATE OR REPLACE FUNCTION render_template_variable(
  template_text TEXT,
  variable_data JSONB
)
RETURNS TEXT AS $$
DECLARE
  result TEXT := template_text;
  var_key TEXT;
  var_value TEXT;
BEGIN
  -- Return empty string if template is null
  IF template_text IS NULL THEN
    RETURN '';
  END IF;
  
  -- Iterate through all keys in the variable_data JSON
  FOR var_key IN SELECT jsonb_object_keys(variable_data) LOOP
    var_value := variable_data ->> var_key;
    -- Replace {{key}} with value
    result := REPLACE(result, '{{' || var_key || '}}', COALESCE(var_value, ''));
  END LOOP;
  
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to validate cron expression (basic validation)
CREATE OR REPLACE FUNCTION validate_cron_expression(
  cron_expr TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  parts TEXT[];
BEGIN
  -- Basic validation: should have 5 parts separated by spaces
  parts := string_to_array(trim(cron_expr), ' ');
  
  -- Should have exactly 5 parts (minute hour day month weekday)
  IF array_length(parts, 1) != 5 THEN
    RETURN FALSE;
  END IF;
  
  -- Very basic validation - just ensure no part is empty
  FOR i IN 1..5 LOOP
    IF parts[i] IS NULL OR trim(parts[i]) = '' THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to get next execution time for a template (simplified)
CREATE OR REPLACE FUNCTION get_next_template_execution(
  template_id_param UUID
)
RETURNS TIMESTAMPTZ AS $$
DECLARE
  template_record RECORD;
BEGIN
  SELECT cron_expression, timezone INTO template_record
  FROM recurring_link_templates
  WHERE id = template_id_param AND status = 'active';
  
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  
  -- For now, return a simple next hour calculation
  -- In production, you'd want to use a proper cron library
  RETURN (now() AT TIME ZONE template_record.timezone + INTERVAL '1 hour') AT TIME ZONE template_record.timezone;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION render_template_variable IS 'Renders a template string with variable substitution from JSON data';
COMMENT ON FUNCTION validate_cron_expression IS 'Basic validation of cron expression format';
COMMENT ON FUNCTION get_next_template_execution IS 'Calculates next execution time for a template (simplified implementation)';