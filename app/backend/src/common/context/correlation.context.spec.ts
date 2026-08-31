import {
  CORRELATION_ID_HEADER,
  getCurrentCorrelationId,
  generateCorrelationId,
  runWithCorrelationId,
} from './correlation.context';

describe('CorrelationContext', () => {
  it('exposes the canonical correlation ID header', () => {
    expect(CORRELATION_ID_HEADER).toBe('X-Correlation-ID');
  });

  it('generates a non-empty UUIDv4 correlation ID', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(generateCorrelationId()).not.toBe(id);
  });

  it('returns undefined outside of a request scope', () => {
    expect(getCurrentCorrelationId()).toBeUndefined();
  });

  it('scopes the correlation ID to the async context', async () => {
    let inside: string | undefined;
    let captured: string | undefined;

    await runWithCorrelationId('corr-123', async () => {
      captured = getCurrentCorrelationId();
      // Simulate async work that inherits the scope.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inside = getCurrentCorrelationId();
    });

    expect(captured).toBe('corr-123');
    expect(inside).toBe('corr-123');
    // Not leaked beyond the scope.
    expect(getCurrentCorrelationId()).toBeUndefined();
  });
});
