DROP FUNCTION IF EXISTS public.save_merchant_payment_preferences(TEXT, INTEGER, JSONB, TEXT, TEXT, TEXT);
DROP INDEX IF EXISTS public.merchant_payment_preference_idempotency_created_at_idx;
DROP TABLE IF EXISTS public.merchant_payment_preference_idempotency;
DROP TABLE IF EXISTS public.merchant_payment_preferences;