import { ReconciliationService } from './reconciliation.service';
import { EscrowDbStatus, PaymentDbStatus } from './types/reconciliation.types';

describe('ReconciliationService divergence detection', () => {
  it('detects missing, duplicate and amount-mismatched escrow records against Horizon', async () => {
    const supabase = {
      fetchPendingEscrows: jest.fn().mockResolvedValue([]),
      fetchPendingPayments: jest.fn().mockResolvedValue([]),
      fetchPaidPayments: jest.fn().mockResolvedValue([]),
      fetchAllEscrows: jest.fn().mockResolvedValue([
        {
          id: 'e1',
          contract_address: 'GA1',
          status: EscrowDbStatus.Active,
          amount: '100',
          asset: 'XLM',
          from_address: 'GFROM',
          to_address: 'GTO',
          expires_at: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'e2',
          contract_address: 'GA1',
          status: EscrowDbStatus.Pending,
          amount: '90',
          asset: 'XLM',
          from_address: 'GFROM',
          to_address: 'GTO',
          expires_at: null,
          created_at: '2024-01-02T00:00:00.000Z',
          updated_at: '2024-01-02T00:00:00.000Z',
        },
        {
          id: 'e3',
          contract_address: 'GA2',
          status: EscrowDbStatus.Pending,
          amount: '150',
          asset: 'XLM',
          from_address: 'GFROM',
          to_address: 'GTO',
          expires_at: null,
          created_at: '2024-01-03T00:00:00.000Z',
          updated_at: '2024-01-03T00:00:00.000Z',
        },
      ]),
      fetchAllPayments: jest.fn().mockResolvedValue([]),
      updateEscrowStatus: jest.fn(),
      updatePaymentStatus: jest.fn(),
      flagIrreconcilableEscrow: jest.fn(),
      flagIrreconcilablePayment: jest.fn(),
    } as any;

    const metrics = {
      recordExternalCall: jest.fn(),
      recordError: jest.fn(),
    } as any;

    const service = new ReconciliationService({ network: 'testnet' } as any, supabase, metrics);
    (service as any).server = {
      loadAccount: jest.fn((address: string) => {
        if (address === 'GA1') {
          return Promise.resolve({ balances: [{ asset_type: 'native', balance: '5.0000000' }] });
        }
        if (address === 'GA2') {
          return Promise.reject({ response: { status: 404 } });
        }
        return Promise.reject(new Error('not found'));
      }),
    };

    const divergences = await (service as any).detectDivergences('run-1', 50);

    expect(divergences.some((d: any) => d.type === 'duplicate' && d.entity === 'escrow')).toBe(true);
    expect(divergences.some((d: any) => d.type === 'missing' && d.entity === 'escrow')).toBe(true);
    expect(divergences.some((d: any) => d.type === 'amount_mismatch' && d.entity === 'escrow')).toBe(true);
  });

  it('computes divergence and auto-match rates from the report', () => {
    const service = new ReconciliationService({ network: 'testnet' } as any, {} as any, {} as any);
    const report = {
      escrows: { processed: 10, updated: 2 },
      payments: { processed: 5, updated: 1 },
      divergences: [
        { type: 'missing', entity: 'escrow' },
        { type: 'duplicate', entity: 'payment' },
      ],
    } as any;

    const metrics = (service as any).buildMetrics(report, 2);
    expect(metrics.divergence_rate).toBeCloseTo(0.1333333333, 5);
    expect(metrics.auto_match_rate).toBeCloseTo(0.2, 5);
  });
});
