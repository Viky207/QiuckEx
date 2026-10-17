import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  Logger,
  NotFoundException,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from "class-validator";

import { HorizonService } from "../transactions/horizon.service";
import { ApiKeyGuard } from "../auth/guards/api-key.guard";

export class RecentPaymentsQuery {
  @IsString()
  @IsNotEmpty()
  @Matches(/^G[A-Z2-7]{55}$/)
  address: string;

  @IsOptional()
  @IsString()
  since?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,40}$/)
  cursor?: string;
}

@ApiTags("payments")
@ApiHeader({
  name: "X-API-Key",
  description: "Optional API key for higher rate limits",
  required: false,
})
@UseGuards(ApiKeyGuard)
@Controller("payments")
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly horizonService: HorizonService) {}

  @Get("recent")
  @ApiOperation({
    summary: "Fetch recent payments for an address",
    description:
      "Returns read-only Stellar payment operations ordered newest first. " +
      "Use nextCursor to fetch the next page; requests are safe to retry.",
  })
  @ApiResponse({ status: 200, description: "List of recent payments" })
  @ApiResponse({ status: 400, description: "Malformed query or expired cursor" })
  @ApiResponse({ status: 401, description: "Invalid optional API key" })
  @ApiResponse({ status: 503, description: "Horizon is unavailable" })
  async recent(@Query() query: RecentPaymentsQuery) {
    const { address, since, limit = 20, cursor } = query;
    const startedAt = Date.now();
    const sinceTs = parseSince(since);

    try {
      const resp = await this.horizonService.getPayments(
        address,
        undefined,
        limit,
        cursor,
      );

      const items = sinceTs
        ? resp.items.filter((item) => new Date(item.timestamp).getTime() > sinceTs)
        : resp.items;

      this.logOutcome("success", startedAt, items.length, limit, Boolean(cursor));
      return { items, nextCursor: resp.nextCursor };
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : undefined;
      if (cursor && status === 400) {
        this.logOutcome("cursor_rejected", startedAt, 0, limit, true);
        throw new BadRequestException({
          code: "PAYMENTS_CURSOR_EXPIRED",
          message: "The payment cursor is no longer available. Refresh the feed.",
        });
      }
      if (status === 404) {
        this.logOutcome("account_not_found", startedAt, 0, limit, Boolean(cursor));
        throw new NotFoundException({
          code: "PAYMENTS_ACCOUNT_NOT_FOUND",
          message: "No Stellar account was found for this address.",
        });
      }

      this.logOutcome("dependency_failure", startedAt, 0, limit, Boolean(cursor));
      throw new ServiceUnavailableException({
        code: "PAYMENTS_UNAVAILABLE",
        message: "Recent payments are temporarily unavailable.",
      });
    }
  }

  private logOutcome(
    outcome: string,
    startedAt: number,
    itemCount: number,
    limit: number,
    hasCursor: boolean,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: "payments.recent.completed",
        outcome,
        latencyMs: Date.now() - startedAt,
        itemCount,
        limit,
        hasCursor,
      }),
    );
  }
}

function parseSince(raw?: string): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n)) {
    if (n > 0) return n;
    throw new BadRequestException({
      code: "VALIDATION_ERROR",
      message: "since must be a positive epoch-millisecond value or ISO timestamp.",
      fields: { since: "INVALID_TIMESTAMP" },
    });
  }
  const d = Date.parse(raw);
  if (!Number.isNaN(d)) return d;
  throw new BadRequestException({
    code: "VALIDATION_ERROR",
    message: "since must be a positive epoch-millisecond value or ISO timestamp.",
    fields: { since: "INVALID_TIMESTAMP" },
  });
}
