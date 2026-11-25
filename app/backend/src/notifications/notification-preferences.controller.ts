import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Patch,
  HttpCode,
  HttpStatus,
  Logger,
  Optional,
  Req,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from "@nestjs/swagger";

import { NotificationPreferencesRepository } from "./notification-preferences.repository";
import {
  UpsertNotificationPreferenceDto,
  UpdateNotificationPreferencesDto,
  NotificationPreferenceResponseDto,
} from "./dto/notification-preferences.dto";
import type { NotificationChannel } from "./types/notification.types";

/** Supported notification channels. */
const SUPPORTED_CHANNELS: readonly NotificationChannel[] = [
  "email",
  "telegram",
  "push",
  "webhook",
];

/** Supported notification frequency options. */
const SUPPORTED_FREQUENCIES: readonly string[] = [
  "instant",
  "daily",
  "weekly",
];

/**
 * REST API for managing per-wallet notification preferences.
 *
 * Routes are keyed by Stellar public key (the wallet address), which serves
 * as the user identity throughout the system.
 *
 * Note: In production you would add the ApiKeyGuard here. For now it is
 * intentionally left open so mobile clients can register preferences without
 * a separate auth flow. Add `@UseGuards(ApiKeyGuard)` when ready.
 */
@ApiTags("Notifications")
@Controller("notifications/preferences")
export class NotificationPreferencesController {
  private readonly logger = new Logger(NotificationPreferencesController.name);

  constructor(
    private readonly prefsRepo: NotificationPreferencesRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  @Get()
  @ApiOperation({ summary: "Get notification preferences for the current user" })
  @ApiResponse({ status: 200, type: [NotificationPreferenceResponseDto] })
  async getCurrentPreferences(@Req() request: { user?: { publicKey?: string } }) {
    const preferences = await this.prefsRepo.getPreferences(this.publicKeyFrom(request));
    return preferences.map(this.toResponse);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update notification preferences for the current user" })
  @ApiResponse({ status: 200, type: [NotificationPreferenceResponseDto] })
  @ApiResponse({ status: 400, description: "Invalid channel or frequency value" })
  async updateCurrentPreferences(
    @Req() request: { user?: { publicKey?: string } },
    @Body() dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferenceResponseDto[]> {
    const publicKey = this.publicKeyFrom(request);
    this.validatePreferences(dto.preferences);
    const preferences = await this.prefsRepo.updatePreferences(
      publicKey,
      dto.preferences.map((preference) => ({
        ...preference,
        minAmountStroops:
          preference.minAmountStroops !== undefined
            ? BigInt(preference.minAmountStroops)
            : undefined,
      })),
    );
    this.eventEmitter?.emit("notification.preference.updated", {
      publicKey,
      preferences,
    });
    return preferences.map(this.toResponse);
  }

  /**
   * GET /notifications/preferences/:publicKey
   * List all notification preferences for a wallet.
   */
  @Get(":publicKey")
  @ApiOperation({ summary: "List notification preferences for a wallet" })
  @ApiParam({ name: "publicKey", description: "Stellar public key (G...)" })
  @ApiResponse({ status: 200, type: [NotificationPreferenceResponseDto] })
  async listPreferences(
    @Param("publicKey") publicKey: string,
  ): Promise<NotificationPreferenceResponseDto[]> {
    // Returns both enabled and disabled; client can filter as needed
    const all = await this.prefsRepo.getEnabledPreferences(publicKey);
    return all.map(this.toResponse);
  }

  /**
   * PUT /notifications/preferences/:publicKey
   * Create or update a channel preference for a wallet.
   */
  @Put(":publicKey")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Create or update a notification channel preference",
  })
  @ApiParam({ name: "publicKey", description: "Stellar public key (G...)" })
  @ApiResponse({ status: 200, type: NotificationPreferenceResponseDto })
  @ApiResponse({ status: 400, description: "Invalid channel or frequency value" })
  @ApiResponse({ status: 403, description: "Cannot update another user's preferences" })
  async upsertPreference(
    @Req() request: { user?: { publicKey?: string } },
    @Param("publicKey") publicKey: string,
    @Body() dto: UpsertNotificationPreferenceDto,
  ): Promise<NotificationPreferenceResponseDto> {
    this.assertOwnership(request, publicKey);
    this.validateChannel(dto.channel, "channel");
    this.validateFrequency((dto as { frequency?: unknown }).frequency, "frequency");

    this.logger.log(
      `Upserting ${dto.channel} preference for ${publicKey.slice(0, 8)}...`,
    );

    const pref = await this.prefsRepo.upsertPreference(publicKey, dto.channel, {
      email: dto.email,
      pushToken: dto.pushToken,
      webhookUrl: dto.webhookUrl,
      webhookSecret: dto.webhookSecret,
      events: dto.events ?? null,
      minAmountStroops:
        dto.minAmountStroops !== undefined
          ? BigInt(dto.minAmountStroops)
          : undefined,
      enabled: dto.enabled,
    });

    return this.toResponse(pref);
  }

  /**
   * DELETE /notifications/preferences/:publicKey/:channel
   * Opt-out of a specific notification channel (soft disable).
   */
  @Delete(":publicKey/:channel")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Opt-out of a notification channel (soft disable)" })
  @ApiParam({ name: "publicKey", description: "Stellar public key (G...)" })
  @ApiParam({ name: "channel", enum: ["email", "telegram", "push", "webhook"] })
  @ApiResponse({ status: 204, description: "Channel disabled" })
  @ApiResponse({ status: 400, description: "Invalid channel value" })
  @ApiResponse({ status: 403, description: "Cannot update another user's preferences" })
  async disableChannel(
    @Req() request: { user?: { publicKey?: string } },
    @Param("publicKey") publicKey: string,
    @Param("channel") channel: NotificationChannel,
  ): Promise<void> {
    this.assertOwnership(request, publicKey);
    this.validateChannel(channel, "channel");

    this.logger.log(`Disabling ${channel} for ${publicKey.slice(0, 8)}...`);
    await this.prefsRepo.disableChannel(publicKey, channel);
  }

  // ---------------------------------------------------------------------------

  private validatePreferences(
    preferences: Array<{ channel?: unknown; frequency?: unknown }>,
  ): void {
    if (!Array.isArray(preferences)) {
      throw new BadRequestException({
        message: "Validation failed",
        errors: [{ field: "preferences", message: "preferences must be an array" }],
      });
    }
    const errors: Array<{ field: string; message: string }> = [];
    preferences.forEach((preference, index) => {
      const channelError = this.channelError(preference.channel);
      if (channelError) {
        errors.push({ field: `preferences[${index}].channel`, message: channelError });
      }
      const frequencyError = this.frequencyError(preference.frequency);
      if (frequencyError) {
        errors.push({ field: `preferences[${index}].frequency`, message: frequencyError });
      }
    });
    if (errors.length > 0) {
      throw new BadRequestException({ message: "Validation failed", errors });
    }
  }

  private validateChannel(value: unknown, field: string): void {
    const error = this.channelError(value);
    if (error) {
      throw new BadRequestException({
        message: "Validation failed",
        errors: [{ field, message: error }],
      });
    }
  }

  private validateFrequency(value: unknown, field: string): void {
    const error = this.frequencyError(value);
    if (error) {
      throw new BadRequestException({
        message: "Validation failed",
        errors: [{ field, message: error }],
      });
    }
  }

  private channelError(value: unknown): string | null {
    if (value === undefined || value === null) {
      return "channel is required";
    }
    if (!SUPPORTED_CHANNELS.includes(value as NotificationChannel)) {
      return `unsupported channel; expected one of: ${SUPPORTED_CHANNELS.join(", ")}`;
    }
    return null;
  }

  private frequencyError(value: unknown): string | null {
    // Frequency is optional; only validate when provided.
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "string" || !SUPPORTED_FREQUENCIES.includes(value)) {
      return `unsupported frequency; expected one of: ${SUPPORTED_FREQUENCIES.join(", ")}`;
    }
    return null;
  }

  private assertOwnership(
    request: { user?: { publicKey?: string } },
    publicKey: string,
  ): void {
    const authenticated = request.user?.publicKey;
    if (!authenticated) {
      throw new UnauthorizedException("Authenticated public key is required");
    }
    if (authenticated !== publicKey) {
      throw new ForbiddenException("Cannot update another user's notification preferences");
    }
  }

  private toResponse(pref: {
    id: string;
    publicKey: string;
    channel: NotificationChannel;
    email?: string;
    pushToken?: string;
    webhookUrl?: string;
    webhookSecret?: string;
    events: string[] | null;
    minAmountStroops: bigint;
    enabled: boolean;
  }): NotificationPreferenceResponseDto {
    const dto = new NotificationPreferenceResponseDto();
    dto.id = pref.id;
    dto.publicKey = pref.publicKey;
    dto.channel = pref.channel;
    dto.email = pref.email;
    dto.pushToken = pref.pushToken;
    dto.webhookUrl = pref.webhookUrl;
    dto.webhookSecret = pref.webhookSecret;
    dto.events = pref.events as NotificationPreferenceResponseDto["events"];
    dto.minAmountStroops = pref.minAmountStroops.toString();
    dto.enabled = pref.enabled;
    return dto;
  }

  private publicKeyFrom(request: { user?: { publicKey?: string } }): string {
    const publicKey = request.user?.publicKey;
    if (!publicKey) {
      throw new UnauthorizedException("Authenticated public key is required");
    }
    return publicKey;
  }
}
