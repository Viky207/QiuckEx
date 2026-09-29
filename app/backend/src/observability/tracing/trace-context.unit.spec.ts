import {
  TRACEPARENT_HEADER,
  TRACEPARENT_RESPONSE_HEADER,
  formatTraceparent,
  getCurrentTrace,
  getCurrentTraceId,
  parseTraceparent,
  runWithTrace,
  sanitizeBaggage,
  startTrace,
  tracePropagationHeaders,
} from "./trace-context";

const VALID_TRACEPARENT =
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("parseTraceparent", () => {
  it("parses a valid W3C traceparent", () => {
    const parsed = parseTraceparent(VALID_TRACEPARENT);

    expect(parsed).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
      sampled: true,
    });
  });

  it("parses the not-sampled flag", () => {
    expect(parseTraceparent(VALID_TRACEPARENT.replace("-01", "-00"))?.sampled).toBe(
      false,
    );
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["too few parts", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7"],
    ["non-hex trace id", "00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-00f067aa0ba902b7-01"],
    ["short trace id", "00-4bf92f35-00f067aa0ba902b7-01"],
    ["short span id", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067-01"],
    ["all-zero trace id", `00-${"0".repeat(32)}-00f067aa0ba902b7-01`],
    ["bad version", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
    ["bad flags", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-zz"],
  ])("rejects %s", (_label, header) => {
    expect(parseTraceparent(header)).toBeNull();
  });
});

describe("startTrace", () => {
  it("continues an inbound trace", () => {
    const trace = startTrace(VALID_TRACEPARENT);

    expect(trace.responseHeader).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(trace.context.parentSpanId).toBe("00f067aa0ba902b7");
  });

  it("mints a fresh trace when the inbound header is absent", () => {
    const trace = startTrace();

    expect(trace.context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(trace.context.parentSpanId).toBeNull();
  });

  it("replaces a malformed inbound header rather than trusting it", () => {
    const trace = startTrace("not-a-traceparent");

    expect(trace.context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(trace.context.traceId).not.toBe("not-a-traceparent");
    expect(trace.context.parentSpanId).toBeNull();
  });

  it("mints distinct trace ids for concurrent requests", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => startTrace().context.traceId),
    );
    expect(ids.size).toBe(50);
  });
});

describe("formatTraceparent", () => {
  it("round-trips a sampled context", () => {
    const context = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: null,
      sampled: true,
    };

    const header = formatTraceparent(context, "00f067aa0ba902b7");

    expect(header).toBe(VALID_TRACEPARENT);
    expect(parseTraceparent(header)?.traceId).toBe(context.traceId);
  });
});

describe("trace scope", () => {
  it("exposes the trace inside the scope and hides it outside", () => {
    const trace = startTrace(VALID_TRACEPARENT);

    expect(getCurrentTrace()).toBeUndefined();
    expect(getCurrentTraceId()).toBeUndefined();
    expect(tracePropagationHeaders()).toEqual({});

    runWithTrace(trace, () => {
      expect(getCurrentTraceId()).toBe("4bf92f3577b34da6a3ce929d0e0e4736");

      const headers = tracePropagationHeaders();
      expect(headers[TRACEPARENT_HEADER]).toMatch(
        /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
      );
      expect(headers[TRACEPARENT_RESPONSE_HEADER]).toBe(
        "4bf92f3577b34da6a3ce929d0e0e4736",
      );
    });

    expect(getCurrentTraceId()).toBeUndefined();
  });

  it("propagates the trace across an await boundary", async () => {
    const trace = startTrace();

    const observed = await runWithTrace(trace, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getCurrentTraceId();
    });

    expect(observed).toBe(trace.context.traceId);
  });

  it("does not leak a trace into an unrelated concurrent scope", async () => {
    const traceA = startTrace();
    const traceB = startTrace();

    const [a, b] = await Promise.all([
      runWithTrace(traceA, async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return getCurrentTraceId();
      }),
      runWithTrace(traceB, async () => getCurrentTraceId()),
    ]);

    expect(a).toBe(traceA.context.traceId);
    expect(b).toBe(traceB.context.traceId);
    expect(a).not.toBe(b);
  });
});

describe("sanitizeBaggage", () => {
  it("returns an empty object for missing baggage", () => {
    expect(sanitizeBaggage(undefined)).toEqual({});
    expect(sanitizeBaggage("")).toEqual({});
  });

  it("keeps only recognised keys", () => {
    expect(
      sanitizeBaggage("tenant=acme,email=user@example.com,deployment=prod"),
    ).toEqual({ tenant: "acme", deployment: "prod" });
  });

  it("drops values that are not short opaque tokens", () => {
    expect(sanitizeBaggage("tenant=<script>alert(1)</script>")).toEqual({});
    expect(sanitizeBaggage(`tenant=${"a".repeat(65)}`)).toEqual({});
  });

  it("does not forward a key with no value", () => {
    expect(sanitizeBaggage("tenant")).toEqual({});
  });
});
