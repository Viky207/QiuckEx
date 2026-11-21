import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ConflictException,
  Headers,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiHeader,
} from "@nestjs/swagger";
import { LinksService } from "./links.service";
import {
  fingerprintLinkMetadataRequest,
  LinkMetadataIdempotencyService,
} from "./link-metadata-idempotency.service";
import { LinkMetadataRequestDto, LinkMetadataResponseDto } from "../dto";
import { LinkValidationError } from "./errors";
import { ApiKeyGuard } from "../auth/guards/api-key.guard";

@ApiTags("links")
@ApiHeader({
  name: "X-API-Key",
  description:
    "Optional API key for higher rate limits (120 req/min vs 20 req/min)",
  required: false,
})
@ApiHeader({
  name: "Idempotency-Key",
  description:
    "Optional 16-128 character url-safe key. Concurrent or repeated requests with the same key and payload share one generation and replay the original response for five minutes.",
  required: false,
})
@UseGuards(ApiKeyGuard)
@Controller("links")
export class LinksController {
  constructor(
    private readonly linksService: LinksService,
    private readonly idempotencyService: LinkMetadataIdempotencyService,
  ) {}

  @Post("metadata")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Generate canonical link metadata",
    description:
      "Validates payment link parameters and generates canonical metadata for frontend consumption",
  })
  @ApiBody({ type: LinkMetadataRequestDto })
  @ApiResponse({
    status: 200,
    description: "Metadata generated successfully",
    type: LinkMetadataResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      "Validation failed. Returns a stable error code and message. " +
      "Signed transaction XDR payloads are limited to a documented maximum size " +
      "(see LinkValidationError codes, e.g. SIGNED_XDR_TOO_LARGE); oversized " +
      "payloads are rejected before decoding or simulation. Raw XDR is never " +
      "echoed in the error response.",
  })
  @ApiResponse({
    status: 409,
    description: "IDEMPOTENCY_CONFLICT – key reused with a different payload",
  })
  @ApiResponse({
    status: 429,
    description: "Rate limit exceeded – retry after 60 seconds",
  })
  async generateMetadata(
    @Body() request: LinkMetadataRequestDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<{ success: boolean; data: LinkMetadataResponseDto }> {
    try {
      if (idempotencyKey) {
        if (!this.idempotencyService.isValidKey(idempotencyKey)) {
          throw new BadRequestException({
            code: "INVALID_IDEMPOTENCY_KEY",
            message:
              "Idempotency-Key must be 16-128 url-safe characters (A-Z, a-z, 0-9, _, -).",
            field: "idempotencyKey",
          });
        }

        const fingerprint = fingerprintLinkMetadataRequest(request);
        const outcome = await this.idempotencyService.run(
          idempotencyKey,
          fingerprint,
          () => this.linksService.generateMetadata(request),
        );
        if (outcome.status === "conflict") {
          throw new ConflictException({
            code: "IDEMPOTENCY_CONFLICT",
            message:
              "Idempotency-Key was reused with a different link metadata payload.",
          });
        }
        return { success: true, data: outcome.response };
      }

      const metadata = await this.linksService.generateMetadata(request);
      return {
        success: true,
        data: metadata,
      };
    } catch (error) {
      if (error instanceof LinkValidationError) {
        throw new BadRequestException({
          code: error.code,
          message: error.message,
          field: error.field,
        });
      }
      throw error;
    }
  }
}
