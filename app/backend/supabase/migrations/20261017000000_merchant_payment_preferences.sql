CREATE TABLE IF NOT EXISTS merchant_payment_preferences (
  public_key TEXT PRIMARY KEY CHECK (public_key ~ '^G[A-Z2-7]{55}$'),
  accepted_assets JSONB NOT NULL DEFAULT '["XLM"]'::jsonb
    CHECK (jsonb_typeof(accepted_assets) = 'array' AND jsonb_array_length(accepted_assets) BETWEEN 1 AND 8),
  settlement_asset TEXT NOT NULL DEFAULT 'XLM',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT merchant_payment_preferences_settlement_asset_check
    CHECK (settlement_asset IN ('XLM', 'USDC', 'AQUA', 'yXLM')),
  CONSTRAINT merchant_payment_preferences_supported_assets_check
    CHECK (accepted_assets <@ '["XLM", "USDC", "AQUA", "yXLM"]'::jsonb),
  CONSTRAINT merchant_payment_preferences_settlement_accepted_check
    CHECK (accepted_assets @> jsonb_build_array(settlement_asset))
);

CREATE TABLE IF NOT EXISTS merchant_payment_preference_idempotency (
  idempotency_key_hash TEXT PRIMARY KEY CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  public_key TEXT NOT NULL CHECK (public_key ~ '^G[A-Z2-7]{55}$'),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS merchant_payment_preference_idempotency_created_at_idx
  ON merchant_payment_preference_idempotency (created_at);

ALTER TABLE merchant_payment_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_payment_preference_idempotency ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE merchant_payment_preferences, merchant_payment_preference_idempotency FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE merchant_payment_preferences, merchant_payment_preference_idempotency TO service_role;

CREATE OR REPLACE FUNCTION save_merchant_payment_preferences(
  p_public_key TEXT,
  p_expected_version INTEGER,
  p_accepted_assets JSONB,
  p_settlement_asset TEXT,
  p_idempotency_key_hash TEXT,
  p_payload_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing merchant_payment_preference_idempotency%ROWTYPE;
  v_preferences merchant_payment_preferences%ROWTYPE;
  v_response JSONB;
BEGIN
  DELETE FROM merchant_payment_preference_idempotency
  WHERE created_at < now() - INTERVAL '24 hours';

  PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key_hash));

  SELECT * INTO v_existing
  FROM merchant_payment_preference_idempotency
  WHERE idempotency_key_hash = p_idempotency_key_hash;

  IF FOUND THEN
    IF v_existing.public_key <> p_public_key OR v_existing.payload_hash <> p_payload_hash THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    RETURN jsonb_set(v_existing.response, '{status}', '"replayed"'::jsonb);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_public_key));

  SELECT * INTO v_existing
  FROM merchant_payment_preference_idempotency
  WHERE idempotency_key_hash = p_idempotency_key_hash;

  IF FOUND THEN
    IF v_existing.public_key <> p_public_key OR v_existing.payload_hash <> p_payload_hash THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    RETURN jsonb_set(v_existing.response, '{status}', '"replayed"'::jsonb);
  END IF;

  SELECT * INTO v_preferences
  FROM merchant_payment_preferences
  WHERE public_key = p_public_key
  FOR UPDATE;

  IF NOT FOUND THEN
    IF p_expected_version <> 0 THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    INSERT INTO merchant_payment_preferences (
      public_key, accepted_assets, settlement_asset, version
    ) VALUES (
      p_public_key, p_accepted_assets, p_settlement_asset, 1
    ) RETURNING * INTO v_preferences;
  ELSE
    IF v_preferences.version <> p_expected_version THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    IF v_preferences.accepted_assets <> p_accepted_assets
      OR v_preferences.settlement_asset <> p_settlement_asset THEN
      UPDATE merchant_payment_preferences
      SET accepted_assets = p_accepted_assets,
          settlement_asset = p_settlement_asset,
          version = version + 1,
          updated_at = now()
      WHERE public_key = p_public_key
      RETURNING * INTO v_preferences;
    END IF;
  END IF;

  v_response := jsonb_build_object(
    'status', 'saved',
    'preferences', jsonb_build_object(
      'publicKey', v_preferences.public_key,
      'acceptedAssets', v_preferences.accepted_assets,
      'settlementAsset', v_preferences.settlement_asset,
      'version', v_preferences.version
    )
  );
  INSERT INTO merchant_payment_preference_idempotency (
    idempotency_key_hash, public_key, payload_hash, response
  ) VALUES (
    p_idempotency_key_hash, p_public_key, p_payload_hash, v_response
  );
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION save_merchant_payment_preferences(TEXT, INTEGER, JSONB, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION save_merchant_payment_preferences(TEXT, INTEGER, JSONB, TEXT, TEXT, TEXT) TO service_role;

-- Rollback:
-- DROP FUNCTION IF EXISTS save_merchant_payment_preferences(TEXT, INTEGER, JSONB, TEXT, TEXT, TEXT);
-- DROP INDEX IF EXISTS merchant_payment_preference_idempotency_created_at_idx;
-- DROP TABLE IF EXISTS merchant_payment_preference_idempotency;
-- DROP TABLE IF EXISTS merchant_payment_preferences;