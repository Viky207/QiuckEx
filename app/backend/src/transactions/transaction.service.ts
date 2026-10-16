import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  ConflictException,
  ForbiddenException,
  GoneException,
  ServiceUnavailableException,
  Optional,
} from "@nestjs/common";
import { createHash } from "crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { ComposePaymentTransactionDto, ComposeTransactionDto, SimulateOperationDto, SubmitSignedTransactionDto } from "./dto/compose-transaction.dto";
import {
  ComposeTransactionResponse,
  ComposeTransactionError,
  ResourceEstimate,
  FeeEstimate,
} from "./dto/compose-transaction-response.dto";
import { buildScVal } from "./utils/param-builder";
import { SorobanRpcService } from "./soroban-rpc.service";
import { mapSorobanError } from "../common/soroban-errors";
import { SorobanErrorCode } from "../common/soroban-errors";
import { HorizonService } from "./horizon.service";
import { AppConfigService } from "../config/app-config.service";

const STROOPS_PER_XLM = 10_000_000;
const BASE_FEE = 100; // stroops

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);
  private readonly idempotencyResponses = new Map<
    string,
    ComposeTransactionResponse | ComposeTransactionError
  >();
  private readonly idempotencyFingerprints = new Map<string, string>();
  private readonly submitIdempotencyResponses = new Map<
    string,
    { success: boolean; hash?: string; error?: string; userMessage?: string }
  >();
  private readonly submitIdempotencyFingerprints = new Map<string, string>();

  constructor(
    private readonly sorobanRpcService: SorobanRpcService,
    @Optional() private readonly horizonService?: HorizonService,
    @Optional() private readonly appConfig?: AppConfigService,
  ) {}

  async composePaymentTransaction(dto: ComposePaymentTransactionDto): Promise<{ unsignedXdr: string; network: "testnet"; expiresAt: string }> {
    if (this.appConfig?.network !== "testnet") {
      throw new ServiceUnavailableException({ code: "WALLET_PAYMENT_DISABLED", message: "Wallet payments are currently available on testnet only." });
    }
    if (!this.horizonService) throw new ServiceUnavailableException({ code: "HORIZON_UNAVAILABLE", message: "Payment composition is temporarily unavailable." });
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(dto.sourceAccount) || !StellarSdk.StrKey.isValidEd25519PublicKey(dto.destinationAccount)) {
      throw new BadRequestException({ code: "MALFORMED_PAYMENT", message: "A valid Stellar source and destination account are required." });
    }
    if (dto.asset !== "XLM") {
      throw new BadRequestException({ code: "UNSUPPORTED_PAYMENT_ASSET", message: "Only native XLM payments are enabled." });
    }
    if (!/^(0|[1-9]\d{0,13})(\.\d{1,7})?$/.test(dto.amount) || Number(dto.amount) <= 0) {
      throw new BadRequestException({ code: "MALFORMED_PAYMENT", message: "Payment amount must be a positive XLM amount with at most seven decimal places." });
    }
    if (dto.expiresAt && (!Number.isFinite(Date.parse(dto.expiresAt)) || Date.parse(dto.expiresAt) <= Date.now())) {
      throw new GoneException({ code: "PAYMENT_LINK_EXPIRED", message: "This payment link has expired." });
    }

    const account = await this.horizonService.loadAccount(dto.sourceAccount);
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const builder = new StellarSdk.TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.appConfig.stellarNetworkPassphrase,
    }).addOperation(StellarSdk.Operation.payment({
      destination: dto.destinationAccount,
      asset: StellarSdk.Asset.native(),
      amount: dto.amount,
    })).setTimeout(300);
    if (dto.memo) builder.addMemo(StellarSdk.Memo.text(dto.memo));
    const transaction = builder.build();
    return { unsignedXdr: transaction.toXDR(), network: "testnet", expiresAt };
  }

  async composeTransaction(
    dto: ComposeTransactionDto,
  ): Promise<ComposeTransactionResponse | ComposeTransactionError> {
    this.validatePayload(dto);

    const payloadFingerprint = this.buildFingerprint(dto);
    const idempotencyKey = dto.idempotencyKey ?? payloadFingerprint;
    const fingerprintForKey = this.idempotencyFingerprints.get(idempotencyKey);
    if (fingerprintForKey && fingerprintForKey !== payloadFingerprint) {
      throw new BadRequestException(
        "This idempotency key was already used with a different payload.",
      );
    }

    const cached = this.idempotencyResponses.get(idempotencyKey);
    if (cached) {
      return cached;
    }

    const startTime = Date.now();

    // 1. Resolve network passphrase
    const networkPassphrase =
      dto.networkPassphrase ??
      (await this.sorobanRpcService.getNetworkPassphrase());

    // 2. Load source account from network (gets current sequence number)
    let account: StellarSdk.Account;
    try {
      account = await this.sorobanRpcService.getAccount(dto.sourceAccount);
    } catch (err) {
      return {
        success: false,
        error: err.message,
        userMessage: `Source account not found: ${err.message}`,
      };
    }

    // 3. Build ScVal params
    let scParams: StellarSdk.xdr.ScVal[];
    try {
      scParams = dto.params.map(buildScVal);
    } catch (err) {
      throw new BadRequestException(`Invalid parameter: ${err.message}`);
    }

    // 4. Build the contract invocation operation
    const contract = new StellarSdk.Contract(dto.contractId);
    const operation = contract.call(dto.method, ...scParams);

    // 5. Build transaction envelope (no private key — unsigned)
    const txBuilder = new StellarSdk.TransactionBuilder(account, {
      fee: String(BASE_FEE),
      networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(StellarSdk.TimeoutInfinite);
    
    // Add canonical memo if provided
    if (dto.memo) {
      switch (dto.memo.type) {
        case 'text':
          txBuilder.addMemo(StellarSdk.Memo.text(dto.memo.value));
          break;
        case 'id':
          // Memo.id requires a string representation of the number
          txBuilder.addMemo(StellarSdk.Memo.id(dto.memo.value));
          break;
        case 'hash':
          // Memo.hash requires a base64 string, not a Buffer
          txBuilder.addMemo(StellarSdk.Memo.hash(Buffer.from(dto.memo.value, 'hex').toString('base64')));
          break;
        case 'return':
          // Memo.return requires a base64 string, not a Buffer
          txBuilder.addMemo(StellarSdk.Memo.return(Buffer.from(dto.memo.value, 'hex').toString('base64')));
          break;
      }
    }
    
    const tx = txBuilder.build();

    // 6. Simulate (preflight)
    this.logger.debug(
      `Simulating transaction: ${dto.contractId}::${dto.method}`,
    );

    let simulationResult: SorobanRpc.Api.SimulateTransactionResponse;
    try {
      simulationResult = await this.sorobanRpcService.simulateTransaction(tx);
    } catch (err) {
      this.logger.error("RPC simulation request failed", err);
      throw new InternalServerErrorException(
        "Failed to reach Soroban RPC provider.",
      );
    }

    const simulationLatencyMs = Date.now() - startTime;

    // 7. Handle simulation failure
    if (SorobanRpc.Api.isSimulationError(simulationResult)) {
      const mapped = mapSorobanError(simulationResult.error);
      this.logger.warn(`Simulation failed [${mapped.code}]: ${simulationResult.error}`);
      const failedResponse: ComposeTransactionError = {
        success: false,
        error: mapped.code,
        userMessage: mapped.message,
        details: mapped.details,
      };
      this.rememberResponse(idempotencyKey, payloadFingerprint, failedResponse);
      return failedResponse;
    }

    // 8. Handle restoration needed
    if (SorobanRpc.Api.isSimulationRestore(simulationResult)) {
      const restoreResponse = {
        success: false,
        error: SorobanErrorCode.RESTORE_REQUIRED,
        userMessage:
          "Some contract state entries have expired and must be restored before this transaction can proceed. Please run a restore operation first.",
        details: {
          restorePreamble: simulationResult.restorePreamble,
        },
      } as ComposeTransactionError;
      this.rememberResponse(idempotencyKey, payloadFingerprint, restoreResponse);
      return restoreResponse;
    }

    // 9. Assemble transaction with simulation results (sets soroban data & resource fee)
    const assembledTx = SorobanRpc.assembleTransaction(
      tx,
      simulationResult,
    ).build();

    // 10. Extract resource estimates  ← REPLACE FROM HERE
    const sorobanData = simulationResult.transactionData.build();
    // In @stellar/stellar-sdk v17 the assembled SorobanTransactionData is a
    // plain XDR struct: `resources`, `instructions`, `footprint`, `readOnly`
    // and `writeBytes` are *properties*, not accessor methods. Calling them
    // throws a TypeError, which previously turned every successful compose
    // into a 500 after the RPC had already done the expensive work.
    const resources = sorobanData.resources;
    const footprint = resources.footprint;

    const resourceEstimate: ResourceEstimate = {
      cpuInstructions: Number(resources.instructions),
      memoryBytes: 0, // not exposed by Soroban RPC simulate response
      ledgerReads: footprint.readOnly.length + footprint.readWrite.length,
      ledgerWrites: footprint.readWrite.length,
      eventBytes: Number(resources.writeBytes ?? 0),
      returnValueBytes: simulationResult.result?.retval
        ? simulationResult.result.retval.toXDR().length
        : 0,
    };

    // 11. Fee breakdown
    const minResourceFee = simulationResult.minResourceFee ?? "0";
    const totalFeeStroops = BASE_FEE + Number(minResourceFee);

    const feeEstimate: FeeEstimate = {
      baseFee: String(BASE_FEE),
      inclusionFee: minResourceFee,
      totalFee: String(totalFeeStroops),
      totalFeeXLM: (totalFeeStroops / STROOPS_PER_XLM).toFixed(7),
    };

    // 12. Return unsigned XDR
    const unsignedXdr = assembledTx.toEnvelope().toXDR("base64");

    this.logger.log(
      `Transaction composed successfully in ${simulationLatencyMs}ms — ` +
        `${dto.contractId}::${dto.method}, fee: ${totalFeeStroops} stroops`,
    );

    const response: ComposeTransactionResponse = {
      success: true,
      unsignedXdr,
      resourceEstimate,
      feeEstimate,
      minResourceFee,
      simulationLatencyMs,
      idempotencyKey,
      simulationSummary: {
        status: "success" as const,
        footprint: {
          readOnly: footprint.readOnly.length,
          readWrite: footprint.readWrite.length,
        },
        estimatedCost: {
          cpuInstructions: resourceEstimate.cpuInstructions,
          ledgerReads: resourceEstimate.ledgerReads,
          ledgerWrites: resourceEstimate.ledgerWrites,
          eventBytes: resourceEstimate.eventBytes,
          returnValueBytes: resourceEstimate.returnValueBytes,
        },
      },
    };
    this.rememberResponse(idempotencyKey, payloadFingerprint, response);
    return response;
  }

  async simulateOperation(
    dto: SimulateOperationDto,
  ): Promise<{ success: boolean; error?: string; userMessage?: string; details?: Record<string, unknown> }> {
    // This endpoint returns deterministic failure reasons based on input parameters
    const { contractId, method, params } = dto;
    
    // Create a deterministic hash from input to get consistent failures
    const inputHash = createHash('sha256').update(JSON.stringify({ contractId, method, params })).digest('hex');
    
    // Deterministic simulation failures based on hash
    if (inputHash.startsWith('00')) {
      return {
        success: false,
        error: SorobanErrorCode.INSUFFICIENT_BALANCE,
        userMessage: 'Insufficient balance to complete this operation. Please add funds to your account.',
        details: { required: '10.0 XLM', available: '5.0 XLM' }
      };
    } else if (inputHash.startsWith('01')) {
      return {
        success: false,
        error: SorobanErrorCode.UNAUTHORIZED,
        userMessage: 'You are not authorised to perform this operation on this contract.',
        details: { caller: dto.sourceAccount, requiredRole: 'admin' }
      };
    } else if (inputHash.startsWith('02')) {
      return {
        success: false,
        error: SorobanErrorCode.CONTRACT_PAUSED,
        userMessage: 'The contract is currently paused. Please try again later.',
        details: { pausedUntil: '2025-12-31T23:59:59Z' }
      };
    } else if (inputHash.startsWith('03')) {
      return {
        success: false,
        error: SorobanErrorCode.BUDGET_EXCEEDED,
        userMessage: 'The transaction exceeds Soroban compute limits. Try simplifying the operation.',
        details: { used: '150000000', limit: '100000000' }
      };
    } else if (inputHash.startsWith('04')) {
      return {
        success: false,
        error: SorobanErrorCode.RESTORE_REQUIRED,
        userMessage: 'Some contract state entries have expired and must be restored before this transaction can proceed.',
        details: { entriesToRestore: 3 }
      };
    } else if (inputHash.startsWith('05')) {
      return {
        success: false,
        error: SorobanErrorCode.STORAGE_MISSING,
        userMessage: 'A required contract state entry does not exist. The resource may not have been initialised.',
        details: { missingKey: 'user_profile:123' }
      };
    }
    
    // Default: simulation successful
    return {
      success: true,
      details: {
        cpuInstructions: 1000000,
        memoryBytes: 256000,
        ledgerReads: 5,
        ledgerWrites: 2,
        eventBytes: 128
      }
    };
  }

  async submitSignedTransaction(
    dto: SubmitSignedTransactionDto,
  ): Promise<{ success: boolean; hash?: string; error?: string; userMessage?: string }> {
    if (this.appConfig?.network !== "testnet") {
      throw new ServiceUnavailableException({ code: "WALLET_PAYMENT_DISABLED", message: "Wallet payments are currently available on testnet only." });
    }
    if (!this.horizonService) throw new ServiceUnavailableException({ code: "HORIZON_UNAVAILABLE", message: "Transaction submission is temporarily unavailable." });

    let transaction: StellarSdk.Transaction;
    try {
      transaction = new StellarSdk.Transaction(StellarSdk.xdr.TransactionEnvelope.fromXDR(dto.signedXdr, 'base64'), this.appConfig.stellarNetworkPassphrase);
    } catch {
      throw new BadRequestException({ code: "MALFORMED_XDR", message: "Signed transaction XDR is malformed." });
    }

    if (!transaction.signatures?.length) {
      throw new ForbiddenException({ code: "UNAUTHORIZED", message: "The transaction has no wallet signature." });
    }
    const timeBounds = transaction.timeBounds;
    if (!timeBounds || Number(timeBounds.maxTime) * 1000 <= Date.now()) {
      throw new GoneException({ code: "TRANSACTION_EXPIRED", message: "The signed transaction has expired. Review and sign a new payment." });
    }
    if (transaction.operations.length !== 1 || transaction.operations[0].type !== "payment" || transaction.operations[0].asset?.getCode?.() !== "XLM") {
      throw new BadRequestException({ code: "MALFORMED_PAYMENT", message: "Only a single native XLM payment transaction is accepted by this endpoint." });
    }

    // Create fingerprint for idempotency checking
    const payloadFingerprint = createHash('sha256').update(JSON.stringify({
      signedXdr: dto.signedXdr,
      networkPassphrase: dto.networkPassphrase
    })).digest('hex');

    const idempotencyKey = dto.idempotencyKey;
    const envelopeFingerprint = createHash('sha256').update(dto.signedXdr).digest('hex');
    if (idempotencyKey !== envelopeFingerprint) {
      throw new ConflictException({ code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key must match the signed envelope fingerprint." });
    }
    const fingerprintForKey = this.submitIdempotencyFingerprints.get(idempotencyKey);
    
    if (fingerprintForKey && fingerprintForKey !== payloadFingerprint) {
      throw new ConflictException({ code: "IDEMPOTENCY_CONFLICT", message: "This idempotency key was already used with a different payload." });
    }

    // Return cached response if already processed this idempotency key
    const cached = this.submitIdempotencyResponses.get(idempotencyKey);
    if (cached) {
      return cached;
    }

    const txHash = transaction.hash().toString('hex');
    let response: { success: boolean; hash?: string; error?: string; userMessage?: string };
    try {
      const existing = await this.horizonService.findTransaction(txHash);
      if (existing) {
        response = { success: true, hash: existing.hash };
      } else {
        const submitted = await this.horizonService.submitSignedTransaction(transaction);
        response = { success: true, hash: submitted.hash };
      }
    } catch (error) {
      const message = String((error as Error)?.message ?? "").toLowerCase();
      if (message.includes("bad_auth") || message.includes("tx_bad_auth")) {
        throw new ForbiddenException({ code: "UNAUTHORIZED", message: "The Stellar network rejected the wallet signature." });
      }
      if (message.includes("tx_bad_seq") || message.includes("tx_too_late") || message.includes("expired")) {
        throw new GoneException({ code: "TRANSACTION_EXPIRED", message: "The signed transaction is no longer valid." });
      }
      if (message.includes("tx_failed") || message.includes("op_")) {
        throw new BadRequestException({ code: "TRANSACTION_REJECTED", message: "The Stellar network rejected this payment." });
      }
      this.logger.warn(`wallet payment submission failed [HORIZON_UNAVAILABLE] hash=${txHash.slice(0, 12)}`);
      throw new ServiceUnavailableException({ code: "HORIZON_UNAVAILABLE", message: "The Stellar network is temporarily unavailable. Retry with the same signed transaction." });
    }

    // Store for idempotency
    this.submitIdempotencyFingerprints.set(idempotencyKey, payloadFingerprint);
    this.submitIdempotencyResponses.set(idempotencyKey, response);
    
    return response;
  }

  private validatePayload(dto: ComposeTransactionDto): void {
    const payloadSize = Buffer.byteLength(JSON.stringify(dto.params ?? []), "utf8");
    if (payloadSize > 4096) {
      throw new BadRequestException("Transaction parameters exceed the 4KB limit.");
    }

    if ((dto.params ?? []).length > 16) {
      throw new BadRequestException("A maximum of 16 contract parameters is supported.");
    }
  }

  private buildFingerprint(dto: ComposeTransactionDto): string {
    const normalized = JSON.stringify({
      contractId: dto.contractId,
      method: dto.method,
      params: dto.params,
      sourceAccount: dto.sourceAccount,
      networkPassphrase: dto.networkPassphrase ?? "__default__",
    });

    return createHash("sha256").update(normalized).digest("hex");
  }

  private rememberResponse(
    idempotencyKey: string,
    fingerprint: string,
    response: ComposeTransactionResponse | ComposeTransactionError,
  ): void {
    this.idempotencyFingerprints.set(idempotencyKey, fingerprint);
    this.idempotencyResponses.set(idempotencyKey, response);
  }
}