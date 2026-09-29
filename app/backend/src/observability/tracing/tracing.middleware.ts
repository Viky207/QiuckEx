import { Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";

import { MetricsService } from "../../metrics/metrics.service";
import {
  TRACEPARENT_HEADER,
  TRACEPARENT_RESPONSE_HEADER,
  runWithTrace,
  sanitizeBaggage,
  startTrace,
} from "./trace-context";

/**
 * Establishes the trace context for every request and records request-scoped
 * trace metrics.
 *
 * The middleware is intentionally cheap: parsing, one response header, and a
 * counter. It never awaits, so it cannot add latency to the request path, and
 * it always establishes a trace (minting one when the caller's `traceparent`
 * is missing or malformed) so a dependency failure is always attributable.
 */
@Injectable()
export class TracingMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header(TRACEPARENT_HEADER);
    const trace = startTrace(inbound);
    const baggage = sanitizeBaggage(req.header("baggage"));

    const outcome = inbound
      ? trace.context.parentSpanId
        ? "continued"
        : "replaced_malformed"
      : "started";

    res.setHeader(TRACEPARENT_RESPONSE_HEADER, trace.responseHeader);
    res.setHeader(TRACEPARENT_HEADER, trace.traceparent);

    // `Object.keys` keeps the label set bounded: baggage is user-controlled, so
    // it must never become a Prometheus label.
    this.metrics.recordTraceContext(outcome, Object.keys(baggage).length > 0);

    runWithTrace(trace, () => next());
  }
}
