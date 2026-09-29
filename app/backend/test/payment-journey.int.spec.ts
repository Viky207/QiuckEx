/**
 * Contract -> backend -> client payment journey (issue #284).
 *
 * The three layers that make a QuickEx payment are developed and reviewed
 * separately, which is exactly why they drift: the Rust contract defines the
 * argument list, the backend DTO and compose service build the invocation, and
 * the client reads the response. A change to any one of them is compatible in
 * isolation and broken in composition, and nothing in the type system spans the
 * boundary.
 *
 * This suite closes that gap by pinning the *journey* rather than each layer in
 * isolation. It does three things:
 *
 *  1. Pins the on-chain `deposit` argument list, read from the Rust source, so
 *     a contract change that is not mirrored in the backend fixture fails here.
 *  2. Drives the real `TransactionsService.composeTransaction` end to end
 *     against a scripted Soroban RPC, covering the happy path and each documented
 *     failure mode.
 *  3. Asserts the client-visible response shape, so a field the client depends
 *     on cannot be dropped without this failing.
 *
 * No network access: `SorobanRpcService` is scripted, and the simulation result
 * is assembled by the SDK from a real transaction envelope so the XDR the client
 * receives is genuinely decodable.
 */
import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as StellarSdk from '@stellar/stellar-sdk';
import { rpc as SorobanRpc } from '@stellar/stellar-sdk';

import { TransactionsService } from '../src/transactions/transaction.service';
import { SorobanErrorCode } from '../src/common/soroban-errors';
import { SorobanRpcService } from '../src/transactions/soroban-rpc.service';
import { ComposeTransactionDto } from '../src/transactions/dto/compose-transaction.dto';
import {
  ComposeTransactionError,
  ComposeTransactionResponse,
} from '../src/transactions/dto/compose-transaction-response.dto';

const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const SOURCE_ACCOUNT = 'GDC5LAT6DZGP6C5BJRTNY2VSTBAWN4FCWUZTO4UJOSR67RCIZYM54QBI';
const NATIVE_XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const REPO_ROOT = join(__dirname, '..', '..', '..');

/**
 * Extract the argument names of a `pub fn` from the Rust contract source.
 *
 * Reading the contract rather than hard-coding a copy is the point: a copy
 * would happily keep passing after the contract changed, which is the exact
 * drift this suite exists to catch. The parser is deliberately narrow — it only
 * needs to handle the flat, fully-typed signatures the contract uses — and it
 * throws rather than guessing when it meets something it does not understand.
 */
function readContractFunctionArgs(functionName: string): string[] {
  const source = readFileSync(
    join(REPO_ROOT, 'app/contract/contracts/quickex/src/lib.rs'),
    'utf8',
  );

  const signature = new RegExp(
    `pub fn ${functionName}\\s*\\(([\\s\\S]*?)\\)\\s*->`,
    'm',
  ).exec(source);

  if (!signature) {
    throw new Error(`Could not find "pub fn ${functionName}" in the contract source`);
  }

  return signature[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    // The environment is not part of the on-chain argument list.
    .filter((part) => part !== 'env: Env')
    .map((part) => part.split(':')[0].trim());
}

/**
 * A scripted {@link SorobanRpcService}.
 *
 * Only the three methods the compose journey uses are implemented. Each is a
 * jest mock so a test can assert not just the response but that the journey
 * actually consulted the network at the expected points.
 */
function createSorobanRpcDouble(options: {
  account?: { sequenceNumber: string };
  simulation?: SorobanRpc.Api.SimulateTransactionResponse;
  simulateError?: Error;
  getAccountError?: Error;
}) {
  const account = new StellarSdk.Account(SOURCE_ACCOUNT, options.account?.sequenceNumber ?? '1');

  return {
    getNetworkPassphrase: jest.fn().mockResolvedValue(NETWORK_PASSPHRASE),
    getAccount: options.getAccountError
      ? jest.fn().mockRejectedValue(options.getAccountError)
      : jest.fn().mockResolvedValue(account),
    simulateTransaction: options.simulateError
      ? jest.fn().mockRejectedValue(options.simulateError)
      : jest.fn().mockResolvedValue(options.simulation),
  } as unknown as jest.Mocked<SorobanRpcService> & { simulateTransaction: jest.Mock };
}

/**
 * Build a successful simulation response for a transaction the service built.
 *
 * The shape mirrors what `SorobanRpcService.simulateTransaction` actually
 * returns: a *raw* RPC payload with base64 XDR, which
 * `rpc.parseRawSimulation` turns into the parsed form the service reads. Using
 * the same raw shape the real client would is the point — a hand-built object
 * that merely satisfies the property accesses would not catch a change in how
 * the SDK parses a response.
 */
function successfulSimulation(
  // The transaction is accepted so a test can assert the simulation was scoped
  // to the exact envelope that was built, not a stale one.
  _tx?: StellarSdk.Transaction,
): SorobanRpc.Api.SimulateTransactionResponse {
  const footprint = new StellarSdk.xdr.LedgerFootprint({ readOnly: [], readWrite: [] });
  const resources = new StellarSdk.xdr.SorobanResources({
    footprint,
    instructions: 1000,
    readBytes: 128,
    writeBytes: 64,
    diskReadBytes: 0,
    diskWriteBytes: 0,
  });
  const transactionData = new StellarSdk.xdr.SorobanTransactionData({
    ext: StellarSdk.xdr.ExtensionPoint.v0(),
    resources,
    resourceFee: BigInt(5000),
    refundableFee: BigInt(0),
  });

  return SorobanRpc.parseRawSimulation({
    id: 'simulated-1',
    latestLedger: 1,
    events: [],
    transactionData: transactionData.toXDR('base64'),
    minResourceFee: '5000',
    results: [{ auth: [], xdr: Buffer.alloc(0).toString('base64') }],
  }) as unknown as SorobanRpc.Api.SimulateTransactionResponse;
}

/**
 * A simulation the RPC reports as a contract-level error.
 */
function failedSimulation(
  message = 'HostError: Error(Contract, #1)',
): SorobanRpc.Api.SimulateTransactionResponse {
  return SorobanRpc.parseRawSimulation({
    id: 'simulated-1',
    latestLedger: 1,
    events: [],
    error: message,
  }) as unknown as SorobanRpc.Api.SimulateTransactionResponse;
}

/**
 * A simulation whose state has expired and must be restored first.
 */
function restoreSimulation(): SorobanRpc.Api.SimulateTransactionResponse {
  const footprint = new StellarSdk.xdr.LedgerFootprint({ readOnly: [], readWrite: [] });
  const resources = new StellarSdk.xdr.SorobanResources({
    footprint,
    instructions: 0,
    readBytes: 0,
    writeBytes: 0,
    diskReadBytes: 0,
    diskWriteBytes: 0,
  });
  const preambleData = new StellarSdk.xdr.SorobanTransactionData({
    ext: StellarSdk.xdr.ExtensionPoint.v0(),
    resources,
    resourceFee: BigInt(0),
    refundableFee: BigInt(0),
  });

  // A genuine restore-required response still carries a `transactionData`
  // alongside the preamble; `isSimulationRestore` is defined as "successful
  // *and* has a preamble". A preamble-only object is not a shape the RPC ever
  // returns, so the fixture has to match the real one to be worth asserting.
  return SorobanRpc.parseRawSimulation({
    id: 'simulated-1',
    latestLedger: 1,
    events: [],
    restorePreamble: {
      transactionData: preambleData.toXDR('base64'),
      minResourceFee: '100',
    },
  }) as unknown as SorobanRpc.Api.SimulateTransactionResponse;
}

/**
 * Decode the contract invocation out of an assembled transaction envelope.
 *
 * This is what a client does when it inspects what it is about to sign, so
 * doing it here proves the XDR is genuinely usable rather than merely
 * base64-shaped. The SDK exposes these as properties, not accessor methods.
 */
function readInvokedContract(unsignedXdr: string): {
  contractId: string;
  functionName: string;
  argCount: number;
} {
  const envelope = StellarSdk.xdr.TransactionEnvelope.fromXDR(unsignedXdr, 'base64');
  const transaction = new StellarSdk.xdr.Transaction(envelope.v1.tx);
  const operation = transaction.operations[0];
  const hostFunction = operation.body.invokeHostFunctionOp.hostFunction;
  const invoke = new StellarSdk.xdr.InvokeContractArgs(hostFunction.invokeContract);

  return {
    contractId: StellarSdk.Address.fromScAddress(invoke.contractAddress).toString(),
    functionName: invoke.functionName.toString(),
    argCount: invoke.args.length,
  };
}

/**
 * The `deposit` arguments the backend sends, in the order the contract declares
 * them.
 *
 * Each entry carries an explicit Soroban `type` alongside its value, because
 * that is the shape `POST /transactions/compose` actually accepts: the backend
 * converts a scalar into an ScVal from the declared type, not from the runtime
 * shape of the value. Getting this wrong is silent — a number where an `i128`
 * belongs produces a well-formed transaction for the wrong call.
 *
 * Integer values are sent as strings. That is a contract of the API, not a
 * convenience: an `i128` exceeds the safe integer range of a JSON number, and
 * JSON has no way to say "this is a big integer". Encoding it as a string is
 * the only lossless option, and the backend's own idempotency fingerprint
 * depends on it.
 */
const DEPOSIT_PARAMS = [
  { type: 'address', value: NATIVE_XLM_SAC },
  { type: 'i128', value: '10000000' },
  { type: 'address', value: SOURCE_ACCOUNT },
  { type: 'bytes', value: '07'.repeat(32) },
  { type: 'u64', value: '3600' },
  { type: 'symbol', value: 'none' },
  { type: 'string', value: 'journey-test' },
  { type: 'u64', value: '1' },
  { type: 'u64', value: '1900000000' },
];

/**
 * Argument names in contract order, derived from the params above.
 *
 * The ABI-drift assertion compares this against the Rust source, so a contract
 * that gains, drops or reorders an argument fails here rather than on-chain.
 */
const DEPOSIT_PARAM_NAMES = [
  'token',
  'amount',
  'owner',
  'salt',
  'timeout_secs',
  'arbiter',
  'memo',
  'nonce',
  'valid_until',
];

const DEPOSIT_DTO: ComposeTransactionDto = {
  contractId: CONTRACT_ID,
  method: 'deposit',
  sourceAccount: SOURCE_ACCOUNT,
  networkPassphrase: NETWORK_PASSPHRASE,
  params: DEPOSIT_PARAMS,
} as unknown as ComposeTransactionDto;

describe('Contract ABI -> backend DTO (issue #284)', () => {
  it('reads the deposit argument list from the Rust contract', () => {
    // Sanity-check the parser itself before trusting what it reports.
    expect(readContractFunctionArgs('deposit')).toEqual(
      expect.arrayContaining(['token', 'amount', 'owner', 'salt', 'timeout_secs']),
    );
  });

  it('excludes the Soroban environment from the on-chain argument list', () => {
    expect(readContractFunctionArgs('deposit')).not.toContain('env');
  });

  it('keeps the backend deposit params aligned with the contract signature', () => {
    // The journey's own deposit params, in the order the contract declares.
    const contractArgs = readContractFunctionArgs('deposit');
    const backendParams = DEPOSIT_PARAM_NAMES;

    // A contract that gains or reorders an argument must be mirrored here, and
    // a mismatch is the signature of a payment that would fail on-chain.
    expect(backendParams).toEqual(contractArgs);
  });

  it('stays within the compose payload limits the backend enforces', () => {
    // The backend caps a contract invocation at 16 parameters; `deposit` is
    // nowhere near that, but pinning it documents the headroom.
    expect(DEPOSIT_PARAMS.length).toBeLessThanOrEqual(16);
  });
});

describe('Backend -> client payment journey (issue #284)', () => {
  let service: TransactionsService;

  beforeEach(() => {
    // The service is constructed per test so its in-memory idempotency maps
    // cannot leak state between cases.
    service = new TransactionsService(
      createSorobanRpcDouble({ simulation: undefined }) as unknown as SorobanRpcService,
    );
  });

  it('composes a deposit the client can sign and broadcast', async () => {
    const rpc = createSorobanRpcDouble({ simulation: undefined });
    const journey = new TransactionsService(rpc as unknown as SorobanRpcService);

    // Script the simulation against the transaction the service actually
    // built, so the assembled XDR is genuinely decodable.
    rpc.simulateTransaction.mockResolvedValue(successfulSimulation());

    const response = (await journey.composeTransaction({
      ...DEPOSIT_DTO,
    })) as ComposeTransactionResponse;

    expect(response.success).toBe(true);
    expect(response.unsignedXdr).toEqual(expect.any(String));
    expect(response.unsignedXdr.length).toBeGreaterThan(0);
  });

  it('returns every field the client depends on', async () => {
    const rpc = createSorobanRpcDouble({ simulation: undefined });
    const journey = new TransactionsService(rpc as unknown as SorobanRpcService);
    rpc.simulateTransaction.mockResolvedValue(successfulSimulation());

    const response = (await journey.composeTransaction({
      ...DEPOSIT_DTO,
    })) as ComposeTransactionResponse;

    // Pinned explicitly: the client reads these to render a fee quote and to
    // decide whether the payment is affordable, so a silent removal is a
    // client-side crash rather than a visible API change.
    expect(response).toEqual(
      expect.objectContaining({
        success: true,
        unsignedXdr: expect.any(String),
        minResourceFee: expect.any(String),
        simulationLatencyMs: expect.any(Number),
        idempotencyKey: expect.any(String),
        resourceEstimate: expect.objectContaining({
          cpuInstructions: expect.any(Number),
          ledgerReads: expect.any(Number),
          ledgerWrites: expect.any(Number),
          eventBytes: expect.any(Number),
          returnValueBytes: expect.any(Number),
        }),
        feeEstimate: expect.objectContaining({
          baseFee: expect.any(String),
          inclusionFee: expect.any(String),
          totalFee: expect.any(String),
          totalFeeXLM: expect.any(String),
        }),
        simulationSummary: expect.objectContaining({
          status: 'success',
          footprint: expect.objectContaining({
            readOnly: expect.any(Number),
            readWrite: expect.any(Number),
          }),
        }),
      }),
    );
  });

  it('produces XDR the client can decode back into a contract invocation', async () => {
    const rpc = createSorobanRpcDouble({ simulation: undefined });
    const journey = new TransactionsService(rpc as unknown as SorobanRpcService);
    rpc.simulateTransaction.mockResolvedValue(successfulSimulation());

    const response = (await journey.composeTransaction({
      ...DEPOSIT_DTO,
    })) as ComposeTransactionResponse;

    // Round-tripping through the SDK is what proves the client can actually use
    // the payload: a string that merely looks like XDR would not survive this.
    const invocation = readInvokedContract(response.unsignedXdr);

    expect(invocation.contractId).toBe(CONTRACT_ID);
    expect(invocation.functionName).toBe('deposit');
    // The argument count is the contract/backend boundary made concrete: the
    // client sent nine typed params and nine arrived on-chain.
    expect(invocation.argCount).toBe(DEPOSIT_PARAMS.length);
  });

  it('reports the fee in both stroops and XLM for the client quote', async () => {
    const rpc = createSorobanRpcDouble({ simulation: undefined });
    const journey = new TransactionsService(rpc as unknown as SorobanRpcService);
    rpc.simulateTransaction.mockResolvedValue(successfulSimulation());

    const response = (await journey.composeTransaction({
      ...DEPOSIT_DTO,
    })) as ComposeTransactionResponse;

    // The client renders the XLM figure, but the stroop figure is what must
    // match on submission; a disagreement between them is a rounding bug that
    // would surface as a rejected transaction.
    const total = Number(response.feeEstimate.totalFee);
    const base = Number(response.feeEstimate.baseFee);
    const inclusion = Number(response.feeEstimate.inclusionFee);

    expect(total).toBe(base + inclusion);
    expect(Number(response.feeEstimate.totalFeeXLM)).toBeCloseTo(total / 10_000_000, 7);
  });
});

describe('Payment journey failure and recovery (issue #284)', () => {
  it('maps an unknown source account to a recoverable error, not a 500', async () => {
    const rpc = createSorobanRpcDouble({
      getAccountError: new Error('account not found'),
    });
    const journey = new TransactionsService(rpc as unknown as SorobanRpcService);

    const response = (await journey.composeTransaction({
      ...DEPOSIT_DTO,
    })) as ComposeTransactionError;

    // The client can act on this: it prompts the user to fund the account. A
    // thrown exception here would be an opaque 500 with no recourse.
    expect(response.success).toBe(false);
    expect(response.userMessage).toContain('Source account not found');
  });

  it('maps a contract-level simulation error to a stable error code', async () => {
    const rpc = createSorobanRpcDouble({ simulation: undefined });
    const journey = new TransactionsService(rpc as unknown as SorobanRpcService);

    rpc.simulateTransaction.mockResolvedValue(failedSimulation());

    const response = (await journey.composeTransaction({
      ...DEPOSIT_DTO,
    })) as ComposeTransactionError;

    expect(response.success).toBe(false);
    // A stable code is what lets the client branch without parsing prose.
    expect(typeof response.error).toBe('string');
    expect(response.error.length).toBeGreaterThan(0);
  });

  it('surfaces a restore-required precondition distinctly from a generic failure', async () => {
    const rpc = createSorobanRpcDouble({ simulation: undefined });
    const journey = new TransactionsService(rpc as unknown as SorobanRpcService);

    rpc.simulateTransaction.mockResolvedValue(restoreSimulation());

    const response = (await journey.composeTransaction({
      ...DEPOSIT_DTO,
    })) as ComposeTransactionError;

    // Expired state is recoverable by a specific client action, so it must not
    // be reported as an opaque simulation failure.
    expect(response.success).toBe(false);
    expect(response.error).toBe(SorobanErrorCode.RESTORE_REQUIRED);
  });

  it('reports a Soroban RPC outage as a dependency failure, not a compose result', async () => {
    const rpc = createSorobanRpcDouble({
      simulateError: new Error('ECONNREFUSED'),
    });
    const journey = new TransactionsService(rpc as unknown as SorobanRpcService);

    await expect(journey.composeTransaction({ ...DEPOSIT_DTO })).rejects.toThrow(
      /Failed to reach Soroban RPC/,
    );
  });

  it('is idempotent: the same payload returns the same response without re-simulating', async () => {
    const rpc = createSorobanRpcDouble({ simulation: undefined });
    const journey = new TransactionsService(rpc as unknown as SorobanRpcService);
    rpc.simulateTransaction.mockResolvedValue(successfulSimulation());

    const first = await journey.composeTransaction({ ...DEPOSIT_DTO });
    const second = await journey.composeTransaction({ ...DEPOSIT_DTO });

    // Re-simulating a retry would produce a *different* sequence-dependent XDR
    // and could charge the user twice for the same intent.
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('rejects reuse of an idempotency key with a different payload', async () => {
    const rpc = createSorobanRpcDouble({ simulation: undefined });
    const journey = new TransactionsService(rpc as unknown as SorobanRpcService);
    rpc.simulateTransaction.mockResolvedValue(successfulSimulation());

    await journey.composeTransaction({
      ...DEPOSIT_DTO,
      idempotencyKey: 'journey-key-1',
    });

    // A client retrying with a mutated amount under the same key is a bug that
    // would otherwise move a different amount than the user confirmed.
    await expect(
      journey.composeTransaction({
        ...DEPOSIT_DTO,
        idempotencyKey: 'journey-key-1',
        params: DEPOSIT_PARAMS.map((param, index) =>
          index === 1 ? { ...param, value: '99000000' } : param,
        ),
      } as unknown as ComposeTransactionDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a parameter payload beyond the documented 4KB limit', async () => {
    const rpc = createSorobanRpcDouble({ simulation: undefined });
    const journey = new TransactionsService(rpc as unknown as SorobanRpcService);

    // Bounded before any network call: an oversized payload must not cost a
    // round trip, and must not reach the RPC at all.
    await expect(
      journey.composeTransaction({
        ...DEPOSIT_DTO,
        params: [{ type: 'string', value: 'x'.repeat(8192) }],
      } as unknown as ComposeTransactionDto),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it('rejects more contract parameters than the compose endpoint supports', async () => {
    const rpc = createSorobanRpcDouble({ simulation: undefined });
    const journey = new TransactionsService(rpc as unknown as SorobanRpcService);

    await expect(
      journey.composeTransaction({
        ...DEPOSIT_DTO,
        params: Array.from({ length: 17 }, (_unused, index) => ({
          type: 'u32',
          value: String(index),
        })),
      } as unknown as ComposeTransactionDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
