import { ScamAlertsService } from './scam-alerts.service';

describe('ScamAlertsService', () => {
  let service: ScamAlertsService;

  beforeEach(() => {
    service = new ScamAlertsService();
  });

  it('returns low risk with no warnings for a normal payment', () => {
    const result = service.validate({
      username: 'alice',
      amount: 25,
      memo: 'Lunch',
      asset: 'USDC',
    });

    expect(result.risk).toBe('low');
    expect(result.warnings).toEqual([]);
  });

  it('warns about a large payment without a memo', () => {
    const result = service.validate({
      username: 'alice',
      amount: 250,
      memo: '',
      asset: 'USDC',
    });

    expect(result.warnings).toContain('Large payment without memo');
  });

  it('warns about an unusual round amount without a memo', () => {
    const result = service.validate({
      username: 'alice',
      amount: 10000,
      memo: '',
      asset: 'USDC',
    });

    expect(result.warnings).toContain('Unusual round amount');
  });

  it('warns about a suspicious username', () => {
    const result = service.validate({
      username: 'quickex-official',
      amount: 25,
      memo: 'Lunch',
      asset: 'USDC',
    });

    expect(result.warnings).toContain('Suspicious username');
  });

  it('warns about a zero-value payment link', () => {
    const result = service.validate({
      username: 'alice',
      amount: 0,
      memo: 'Lunch',
      asset: 'USDC',
    });

    expect(result.warnings).toContain('Zero-value payment link');
  });

  it('escalates risk to high when multiple warnings are present', () => {
    const result = service.validate({
      username: 'support',
      amount: 10000,
      memo: '',
      asset: 'USDC',
    });

    expect(result.risk).toBe('high');
    expect(result.warnings.length).toBeGreaterThan(1);
  });
});
