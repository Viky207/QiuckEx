import {
  Controller,
  Get,
  Query,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from "@nestjs/swagger";
import { PaymentLinkService } from "./payment-link.service";
import { PaymentLinkStatusDto } from "../dto/link/payment-link-status.dto";
import { CustomThrottlerGuard } from "../auth/guards/custom-throttler.guard";

@ApiTags("payment-links")
@UseGuards(CustomThrottlerGuard)
@Controller("payment-links")
export class PaymentLinkController {
  constructor(private readonly paymentLinkService: PaymentLinkService) {}

  @Get("status")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Get payment link status",
    description:
      "Returns the current state (active/expired/paid/refunded) of a payment link " +
      "based on username, amount, and optional memo. Checks on-chain to determine if paid.",
  })
  @ApiQuery({
    name: "username",
    description: "Username for the payment link",
    example: "john_doe",
  })
  @ApiQuery({ name: "amount", description: "Payment amount", example: 100 })
  @ApiQuery({
    name: "asset",
    description:
      "Asset identity (default: native XLM). Accepts a canonical identifier of the form " +
      "`network:type:code:issuer` (e.g. `public:credit_alphanum4:USDC:GA5Z...`). " +
      "A bare code such as `XLM` is treated as the native asset; a bare non-native code " +
      "is resolved only when unambiguous, otherwise the request is rejected.",
    example: "public:native:XLM:",
    required: false,
  })
  @ApiQuery({
    name: "memo",
    description: "Optional memo text",
    example: "Invoice #123",
    required: false,
  })
  @ApiQuery({
    name: "acceptedAssets",
    description:
      "Comma-separated list of accepted asset identities. Each entry uses the same " +
      "canonical `network:type:code:issuer` form as `asset`; bare codes are accepted " +
      "only for the native asset. Duplicate codes from distinct issuers are kept distinct.",
    example: "public:native:XLM:,public:credit_alphanum4:USDC:GA5Z...",
    required: false,
  })
  @ApiResponse({
    status: 200,
    description: "Payment link status retrieved successfully",
    type: PaymentLinkStatusDto,
  })
  @ApiResponse({
    status: 404,
    description: "Username not found",
  })
  @ApiResponse({
    status: 429,
    description: "Rate limit exceeded – retry after 60 seconds",
  })
  async getPaymentLinkStatus(
    @Query("username") username: string,
    @Query("amount") amount: string,
    @Query("asset") asset?: string,
    @Query("memo") memo?: string,
    @Query("acceptedAssets") acceptedAssets?: string,
  ): Promise<PaymentLinkStatusDto> {
    if (!username) {
      throw new BadRequestException("username is required");
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      throw new BadRequestException("amount must be a valid positive number");
    }

    const acceptedAssetsArray = acceptedAssets
      ? acceptedAssets
          .split(",")
          .map((a) => a.trim())
          .filter((a) => a.length > 0)
      : undefined;

    return this.paymentLinkService.getPaymentLinkStatus({
      username,
      amount: amountNum,
      asset: asset && asset.trim().length > 0 ? asset.trim() : "XLM",
      memo,
      acceptedAssets: acceptedAssetsArray,
    });
  }
}
