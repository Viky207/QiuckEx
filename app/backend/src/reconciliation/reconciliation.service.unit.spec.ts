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

  it('uses the Horizon payment operation amount for observed totals', async () => {
    const payment = {
      id: 'p1',
      stellar_tx_hash: 'tx-hash',
      status: PaymentDbStatus.Paid,
      amount: '10.0000000',
      asset: 'XLM',
      from_address: 'GFROM',
      to_address: 'GTO',
      memo: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };
    const supabase = { fetchPaidPayments: jest.fn().mockResolvedValue([payment]) } as any;
    const metrics = { recordExternalCall: jest.fn(), recordError: jest.fn() } as any;
    const service = new ReconciliationService({ network: 'testnet' } as any, supabase, metrics);
    (service as any).server = {
      transactions: () => ({ transaction: () => ({ call: jest.fn().mockResolvedValue({ successful: true }) }) }),
      operations: () => ({
        forTransaction: () => ({
          limit: () => ({
            call: jest.fn().mockResolvedValue({
              records: [{
                type: 'payment',
                from: 'GFROM',
                to: 'GTO',
                asset_type: 'native',
                amount: '9.5000000',
              }],
            }),
          }),
        }),
      }),
    };

    const comparison = await (service as any).comparePaymentTotals('run-1');
    expect(comparison.payments.expectedTotalAmount).toBe('100000000');
    expect(comparison.payments.observedTotalAmount).toBe('95000000');
    expect(comparison.payments.amountMismatchCount).toBe(1);
    expect(comparison.payments.assets.XLM.observedTotalAmount).toBe('95000000');
    expect(comparison.payments.exceedsThreshold).toBe(true);
  });

  it('marks totals incomplete when a successful transaction has no observable payment operation', async () => {
    const payment = {
      id: 'p2',
      stellar_tx_hash: 'soroban-tx',
      status: PaymentDbStatus.Paid,
      amount: '5.0000000',
      asset: 'XLM',
      from_address: 'GFROM',
      to_address: 'GTO',
      memo: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };
    const service = new ReconciliationService(
      { network: 'testnet' } as any,
      { fetchPaidPayments: jest.fn().mockResolvedValue([payment]) } as any,
      { recordExternalCall: jest.fn(), recordError: jest.fn() } as any,
    );
    (service as any).server = {
      transactions: () => ({ transaction: () => ({ call: jest.fn().mockResolvedValue({ successful: true }) }) }),
      operations: () => ({
        forTransaction: () => ({
          limit: () => ({ call: jest.fn().mockResolvedValue({ records: [{ type: 'invoke_host_function' }] }) }),
        }),
      }),
    };

    const comparison = await (service as any).comparePaymentTotals('run-2');
    expect(comparison.payments.unresolvedCount).toBe(1);
    expect(comparison.payments.complete).toBe(false);
    expect(comparison.payments.observedTotalAmount).toBe('0');
    expect((service as any).generateDiscrepancyAlert({
      runId: 'run-2',
      totalsComparison: comparison,
    })).toEqual(expect.objectContaining({ severity: 'warning' }));
  });

  it('does not match an issued asset by code when its issuer differs', async () => {
    const payment = {
      id: 'p3',
      stellar_tx_hash: 'issued-asset-tx',
      status: PaymentDbStatus.Paid,
      amount: '5.0000000',
      asset: 'USDC:GISSUER_A',
      from_address: 'GFROM',
      to_address: 'GTO',
      memo: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };
    const service = new ReconciliationService(
      { network: 'testnet' } as any,
      { fetchPaidPayments: jest.fn().mockResolvedValue([payment]) } as any,
      { recordExternalCall: jest.fn(), recordError: jest.fn() } as any,
    );
    (service as any).server = {
      transactions: () => ({ transaction: () => ({ call: jest.fn().mockResolvedValue({ successful: true }) }) }),
      operations: () => ({
        forTransaction: () => ({
          limit: () => ({
            call: jest.fn().mockResolvedValue({
              records: [{
                type: 'payment',
                from: 'GFROM',
                to: 'GTO',
                asset_type: 'credit_alphanum4',
                asset_code: 'USDC',
                asset_issuer: 'GISSUER_B',
                amount: '5.0000000',
              }],
            }),
          }),
        }),
      }),
    };

    const comparison = await (service as any).comparePaymentTotals('run-3');
    expect(comparison.payments.unresolvedCount).toBe(1);
    expect(comparison.payments.observedCount).toBe(0);
  });
});
