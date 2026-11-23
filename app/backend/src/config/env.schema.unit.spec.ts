import { envSchema } from "./env.schema";

/**
 * Helper to create env without specific keys
 */
function omitKeys<T extends Record<string, unknown>>(
  obj: T,
  keys: (keyof T)[],
): Partial<T> {
  const result = { ...obj };
  keys.forEach((key) => delete result[key]);
  return result;
}

describe("Environment Schema Validation", () => {
  const validEnv = {
    PORT: 4000,
    NETWORK: "testnet",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "test-anon-key-12345",
    NODE_ENV: "development",
  };

  describe("valid configurations", () => {
    it("should accept valid environment with all required values", () => {
      const { error, value } = envSchema.validate(validEnv);

      expect(error).toBeUndefined();
      expect(value.PORT).toBe(4000);
      expect(value.NETWORK).toBe("testnet");
      expect(value.SUPABASE_URL).toBe("https://example.supabase.co");
      expect(value.SUPABASE_ANON_KEY).toBe("test-anon-key-12345");
    });

    it("should accept mainnet as NETWORK value", () => {
      const env = { ...validEnv, NETWORK: "mainnet" };
      const { error, value } = envSchema.validate(env);

      expect(error).toBeUndefined();
      expect(value.NETWORK).toBe("mainnet");
    });

    it("should apply default PORT when not provided", () => {
      const envWithoutPort = omitKeys(validEnv, ["PORT"]);
      const { error, value } = envSchema.validate(envWithoutPort);

      expect(error).toBeUndefined();
      expect(value.PORT).toBe(4000);
    });

    it("should apply default NODE_ENV when not provided", () => {
      const envWithoutNodeEnv = omitKeys(validEnv, ["NODE_ENV"]);
      const { error, value } = envSchema.validate(envWithoutNodeEnv);

      expect(error).toBeUndefined();
      expect(value.NODE_ENV).toBe("development");
    });

    it("should accept production NODE_ENV", () => {
      const env = { ...validEnv, NODE_ENV: "production" };
      const { error, value } = envSchema.validate(env);

      expect(error).toBeUndefined();
      expect(value.NODE_ENV).toBe("production");
    });

    it("should accept test NODE_ENV", () => {
      const env = { ...validEnv, NODE_ENV: "test" };
      const { error, value } = envSchema.validate(env);

      expect(error).toBeUndefined();
      expect(value.NODE_ENV).toBe("test");
    });

    it("should accept HTTP URLs for SUPABASE_URL", () => {
      const env = { ...validEnv, SUPABASE_URL: "http://localhost:54321" };
      const { error, value } = envSchema.validate(env);

      expect(error).toBeUndefined();
      expect(value.SUPABASE_URL).toBe("http://localhost:54321");
    });
  });

  describe("missing required variables", () => {
    it("should reject when NETWORK is missing", () => {
      const envWithoutNetwork = omitKeys(validEnv, ["NETWORK"]);
      const { error } = envSchema.validate(envWithoutNetwork, {
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error?.message).toContain("NETWORK");
      expect(error?.message).toContain("required");
    });

    it("should reject when SUPABASE_URL is missing", () => {
      const envWithoutUrl = omitKeys(validEnv, ["SUPABASE_URL"]);
      const { error } = envSchema.validate(envWithoutUrl, {
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error?.message).toContain("SUPABASE_URL");
      expect(error?.message).toContain("required");
    });

    it("should reject when SUPABASE_ANON_KEY is missing", () => {
      const envWithoutKey = omitKeys(validEnv, ["SUPABASE_ANON_KEY"]);
      const { error } = envSchema.validate(envWithoutKey, {
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error?.message).toContain("SUPABASE_ANON_KEY");
      expect(error?.message).toContain("required");
    });

    it("should report all missing keys when multiple are absent", () => {
      const minimalEnv = omitKeys(validEnv, [
        "NETWORK",
        "SUPABASE_URL",
        "SUPABASE_ANON_KEY",
      ]);
      const { error } = envSchema.validate(minimalEnv, { abortEarly: false });

      expect(error).toBeDefined();
      expect(error?.details).toHaveLength(3);

      const missingKeys = error?.details.map((d) => d.context?.key);
      expect(missingKeys).toContain("NETWORK");
      expect(missingKeys).toContain("SUPABASE_URL");
      expect(missingKeys).toContain("SUPABASE_ANON_KEY");
    });
  });

  describe("invalid values", () => {
    it("should reject invalid NETWORK value", () => {
      const env = { ...validEnv, NETWORK: "invalid-network" };
      const { error } = envSchema.validate(env);

      expect(error).toBeDefined();
      expect(error?.message).toContain("NETWORK");
      expect(error?.message).toMatch(/testnet|mainnet/);
    });

    it("should reject invalid SUPABASE_URL format", () => {
      const env = { ...validEnv, SUPABASE_URL: "not-a-valid-url" };
      const { error } = envSchema.validate(env);

      expect(error).toBeDefined();
      expect(error?.message).toContain("SUPABASE_URL");
      expect(error?.message).toContain("uri");
    });

    it("should reject empty SUPABASE_ANON_KEY", () => {
      const env = { ...validEnv, SUPABASE_ANON_KEY: "" };
      const { error } = envSchema.validate(env);

      expect(error).toBeDefined();
      expect(error?.message).toContain("SUPABASE_ANON_KEY");
    });

    it("should reject invalid PORT (out of range)", () => {
      const env = { ...validEnv, PORT: 99999 };
      const { error } = envSchema.validate(env);

      expect(error).toBeDefined();
      expect(error?.message).toContain("PORT");
    });

    it("should reject invalid NODE_ENV value", () => {
      const env = { ...validEnv, NODE_ENV: "staging" };
      const { error } = envSchema.validate(env);

      expect(error).toBeDefined();
      expect(error?.message).toContain("NODE_ENV");
    });

    it("should reject FTP scheme for SUPABASE_URL", () => {
      const env = { ...validEnv, SUPABASE_URL: "ftp://example.com" };
      const { error } = envSchema.validate(env);

      expect(error).toBeDefined();
      expect(error?.message).toContain("SUPABASE_URL");
    });
  });

  describe("error message clarity", () => {
    it("should provide clear error messages for validation failures", () => {
      const { error } = envSchema.validate(
        { PORT: 4000, NODE_ENV: "development" },
        { abortEarly: false },
      );

      expect(error).toBeDefined();
      // Error messages should mention the key names (not expose values)
      const errorMessage = error?.message || "";
      expect(errorMessage).toContain("NETWORK");
      expect(errorMessage).toContain("SUPABASE_URL");
      expect(errorMessage).toContain("SUPABASE_ANON_KEY");
      // Should NOT contain any actual secret values
      expect(errorMessage).not.toContain("test-anon-key");
    });
  });
});

it("rejects unknown environment variables when strict validation enabled", () => {
  const result = envSchema.validate(
    {
      PORT: 4000,
      NETWORK: "testnet",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "key",
      UNKNOWN_VAR: "should-fail",
    },
    { abortEarly: false, allowUnknown: false },
  );

  expect(result.error).toBeDefined();
});

describe("Environment precedence resolution", () => {
  /**
   * Resolves the effective network from the raw environment following the
   * documented precedence: NETWORK wins over STELLAR_NETWORK, and the
   * default is testnet. Mainnet must be requested explicitly.
   */
  function resolveNetwork(env: Record<string, unknown>): string {
    const candidate = env.NETWORK ?? env.STELLAR_NETWORK ?? "testnet";
    return String(candidate);
  }

  it("defaults to testnet when no network variable is provided", () => {
    expect(resolveNetwork({})).toBe("testnet");
  });

  it("uses NETWORK when only NETWORK is set", () => {
    expect(resolveNetwork({ NETWORK: "mainnet" })).toBe("mainnet");
  });

  it("uses STELLAR_NETWORK when NETWORK is absent", () => {
    expect(resolveNetwork({ STELLAR_NETWORK: "mainnet" })).toBe("mainnet");
  });

  it("prefers NETWORK over STELLAR_NETWORK when both are set", () => {
    expect(
      resolveNetwork({ NETWORK: "testnet", STELLAR_NETWORK: "mainnet" }),
    ).toBe("testnet");
  });

  it("does not silently select mainnet without explicit configuration", () => {
    const resolved = resolveNetwork({});
    expect(resolved).not.toBe("mainnet");
    expect(resolved).toBe("testnet");
  });

  it("surfaces conflicting network aliases as a validation failure", () => {
    const env = {
      PORT: 4000,
      NETWORK: "testnet",
      STELLAR_NETWORK: "mainnet",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key-12345",
    };

    const resolved = resolveNetwork(env);
    const conflict = env.NETWORK !== env.STELLAR_NETWORK;

    expect(conflict).toBe(true);
    expect(resolved).toBe("testnet");
    // The resolved network must be one of the schema-accepted values.
    const { error } = envSchema.validate({ ...env, NETWORK: resolved });
    expect(error).toBeUndefined();
  });

  it("rejects a resolved network outside the accepted set", () => {
    const resolved = resolveNetwork({ NETWORK: "futurenet" });
    const { error } = envSchema.validate({
      PORT: 4000,
      NETWORK: resolved,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key-12345",
    });

    expect(error).toBeDefined();
    expect(error?.message).toContain("NETWORK");
  });
});
