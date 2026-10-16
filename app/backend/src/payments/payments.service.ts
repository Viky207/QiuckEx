import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';
import { Horizon } from '@stellar/stellar-sdk';

const HORIZON_TIMEOUT_MS = 5000;
const HORIZON_UNREACHABLE_MESSAGE =
  'Stellar network is temporarily unreachable. Please try again.';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly server: Horizon.Server;

  constructor(private readonly configService: ConfigService) {
    const network = this.configService.get<string>('STELLAR_NETWORK', 'testnet');
    const horizonUrl =
      network === 'mainnet'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org';

    this.server = new Horizon.Server(horizonUrl);
  }

  /**
   * Wraps a Horizon SDK call with a hard timeout so a slow or unreachable
   * Horizon node cannot hang the request handler or surface as an uncaught
   * promise rejection.
   */
  private async withHorizonTimeout<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new Error(
            `Horizon request timed out after ${HORIZON_TIMEOUT_MS}ms`,
          ),
        );
      }, HORIZON_TIMEOUT_MS);
    });

    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private handleHorizonError(error: unknown): never {
    this.logger.error(
      `Horizon request failed: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error.stack : undefined,
    );

    Sentry.captureException(error, {
      tags: { service: 'payments', dependency: 'horizon' },
    });

    throw new ServiceUnavailableException({
      error: HORIZON_UNREACHABLE_MESSAGE,
    });
  }

  async getPaymentsByUsername(username: string) {
    try {
      const account = await this.withHorizonTimeout(() =>
        this.server.accounts().accountId(username).call(),
      );

      const payments = await this.withHorizonTimeout(() =>
        this.server
          .payments()
          .forAccount(account.account_id)
          .order('desc')
          .limit(50)
          .call(),
      );

      return payments.records;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      this.handleHorizonError(error);
    }
  }
}
