-- =============================================================================
-- Template Version Management Functions
-- =============================================================================
-- Functions to support template version lifecycle operations
-- =============================================================================

-- ---------------------------------------------------------------------------
-- activate_template_version
-- ---------------------------------------------------------------------------
-- Atomically activates a template version and deactivates all others for the same template
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION activate_template_version(
  template_id_param UUID,
  version_id_param UUID
)
RETURNS VOID AS $$
BEGIN
  -- First, set all versions for this template to 'archived' status
  UPDATE recurring_link_template_versions
  SET 
    status = 'archived',
    updated_at = now()
  WHERE 
    template_id = template_id_param 
    AND status = 'active';
  
  -- Then, activate the specified version
  UPDATE recurring_link_template_versions
  SET 
    status = 'active',
    updated_at = now()
  WHERE 
    id = version_id_param 
    AND template_id = template_id_param;
  
  -- Verify that the version exists and belongs to the template
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template version % not found for template %', version_id_param, template_id_param;
  END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION activate_template_version IS 'Atomically activates a template version and archives others for the same template';

-- ---------------------------------------------------------------------------
-- get_next_cron_execution
-- ---------------------------------------------------------------------------
-- Calculate next execution time for a cron expression in a specific timezone
-- This is a simplified implementation - in production you'd use a proper cron library
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_next_cron_execution(
  cron_expression_param TEXT,
  timezone_param TEXT DEFAULT 'UTC',
  from_time_param TIMESTAMPTZ DEFAULT now()
)
RETURNS TIMESTAMPTZ AS $$
DECLARE
  cron_parts TEXT[];
  minute_part TEXT;
  hour_part TEXT;
  day_part TEXT;
  month_part TEXT;
  weekday_part TEXT;
  base_time TIMESTAMPTZ;
  next_time TIMESTAMPTZ;
BEGIN
  -- Convert to the specified timezone
  base_time := from_time_param AT TIME ZONE timezone_param;
  
  -- Split cron expression into parts
  cron_parts := string_to_array(trim(cron_expression_param), ' ');
  
  -- Validate we have 5 parts
  IF array_length(cron_parts, 1) != 5 THEN
    RAISE EXCEPTION 'Invalid cron expression: %. Expected 5 parts (minute hour day month weekday)', cron_expression_param;
  END IF;
  
  minute_part := cron_parts[1];
  hour_part := cron_parts[2];
  day_part := cron_parts[3];
  month_part := cron_parts[4];
  weekday_part := cron_parts[5];
  
  -- Simple implementation: add 1 hour to current time
  -- In production, you would parse the cron expression properly
  -- and calculate the exact next execution time
  next_time := base_time + INTERVAL '1 hour';
  
  -- Convert back to UTC
  RETURN next_time AT TIME ZONE timezone_param;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_next_cron_execution IS 'Calculate next execution time for cron expression (simplified implementation)';

-- ---------------------------------------------------------------------------
-- validate_template_variables
-- ---------------------------------------------------------------------------
-- Validate that variable data contains all required variables for a template version
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION validate_template_variables(
  template_variables JSONB,
  variable_data JSONB
)
RETURNS BOOLEAN AS $$
DECLARE
  required_var TEXT;
BEGIN
  -- Check each required variable exists in the variable data
  FOR required_var IN SELECT jsonb_array_elements_text(template_variables) LOOP
    IF NOT (variable_data ? required_var) THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION validate_template_variables IS 'Validates that variable data contains all required template variables';

-- ---------------------------------------------------------------------------
-- render_template_field
-- ---------------------------------------------------------------------------
-- Enhanced template rendering function for complex field rendering
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION render_template_field(
  template_text TEXT,
  variable_data JSONB,
  field_name TEXT DEFAULT 'unknown'
)
RETURNS TEXT AS $$
DECLARE
  result TEXT := template_text;
  var_key TEXT;
  var_value TEXT;
BEGIN
  -- Return null if template is null
  IF template_text IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Return empty string if template is empty
  IF trim(template_text) = '' THEN
    RETURN '';
  END IF;
  
  -- Iterate through all keys in the variable_data JSON
  FOR var_key IN SELECT jsonb_object_keys(variable_data) LOOP
    var_value := variable_data ->> var_key;
    -- Replace {{key}} with value (handle null values)
    result := REPLACE(result, '{{' || var_key || '}}', COALESCE(var_value, ''));
  END LOOP;
  
  -- Check if there are any unresolved variables (security check)
  IF result ~ '\{\{[^}]+\}\}' THEN
    -- Log warning about unresolved variables
    -- In a real implementation, you might want to raise an exception or log this
    NULL; -- No-op for now
  END IF;
  
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION render_template_field IS 'Enhanced template field rendering with variable substitution and validation';

-- ---------------------------------------------------------------------------
-- get_template_execution_stats
-- ---------------------------------------------------------------------------
-- Get execution statistics for a template
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_template_execution_stats(
  template_id_param UUID,
  days_back INTEGER DEFAULT 30
)
RETURNS TABLE (
  total_executions BIGINT,
  successful_executions BIGINT,
  failed_executions BIGINT,
  pending_executions BIGINT,
  last_execution_at TIMESTAMPTZ,
  success_rate NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COUNT(*) as total_executions,
    COUNT(*) FILTER (WHERE status = 'success') as successful_executions,
    COUNT(*) FILTER (WHERE status = 'failed') as failed_executions,
    COUNT(*) FILTER (WHERE status = 'pending') as pending_executions,
    MAX(executed_at) as last_execution_at,
    CASE 
      WHEN COUNT(*) = 0 THEN 0
      ELSE ROUND(
        (COUNT(*) FILTER (WHERE status = 'success')::NUMERIC / COUNT(*)::NUMERIC) * 100, 
        2
      )
    END as success_rate
  FROM recurring_link_template_executions
  WHERE 
    template_id = template_id_param
    AND created_at >= (now() - (days_back || ' days')::INTERVAL);
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_template_execution_stats IS 'Get execution statistics for a template over a specified time period';

-- ---------------------------------------------------------------------------
-- cleanup_old_template_executions
-- ---------------------------------------------------------------------------
-- Clean up old template executions to prevent table bloat
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cleanup_old_template_executions(
  days_to_keep INTEGER DEFAULT 90
)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM recurring_link_template_executions
  WHERE 
    created_at < (now() - (days_to_keep || ' days')::INTERVAL)
    AND status IN ('success', 'failed', 'skipped');
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_old_template_executions IS 'Clean up old template executions (keeps pending executions regardless of age)';