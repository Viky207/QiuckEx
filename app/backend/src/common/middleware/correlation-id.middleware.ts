import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import {
  getCurrentCorrelationId,
  generateCorrelationId,
  runWithCorrelationId,
  CORRELATION_ID_HEADER,
} from '../context/correlation.context';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const inbound =
      req.header('x-request-id') ||
      req.header('x-correlation-id') ||
      req.header(CORRELATION_ID_HEADER);
    const correlationId = inbound || getCurrentCorrelationId() || generateCorrelationId();
    // Expose as both the legacy header and the canonical request-id header
    res.setHeader('x-request-id', correlationId);
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    req['correlationId'] = correlationId;
    // Propagate the ID across all downstream async work (controllers, services
    // and any outbound calls to Horizon, Soroban RPC or Supabase) via ALS.
    runWithCorrelationId(correlationId, () => next());
  }
}