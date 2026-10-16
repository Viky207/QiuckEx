import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { InAppNotificationRepository } from "./in-app-notification.repository";
import { MarkManyReadDto } from "./dto/mark-many-read.dto";
import { InAppNotificationQueryDto } from "./dto/in-app-notification-query.dto";
import type { InAppNotification } from "./entities/in-app-notification.entity";

export interface InAppNotificationListResponse {
  data: InAppNotification[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    has_more: boolean;
  };
}

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly inAppRepo: InAppNotificationRepository) {}

  @Get("in-app")
  async getInApp(
    @Req() req,
    @Query() query: InAppNotificationQueryDto,
  ): Promise<InAppNotificationListResponse> {
    const publicKey = req.user?.publicKey ?? query.publicKey;
    if (!publicKey) {
      throw new UnauthorizedException({
        code: "NOTIFICATION_UNAUTHORIZED",
        message: "A wallet public key is required",
      });
    }
    if (req.user?.publicKey && query.publicKey !== req.user.publicKey) {
      throw new ForbiddenException({
        code: "NOTIFICATION_UNAUTHORIZED",
        message: "The requested wallet does not match the authenticated wallet",
      });
    }

    let result: Awaited<
      ReturnType<InAppNotificationRepository["findByUser"]>
    >;
    try {
      result = await this.inAppRepo.findByUser(
        publicKey,
        query.page,
        query.limit,
      );
    } catch {
      throw new ServiceUnavailableException({
        code: "NOTIFICATIONS_UNAVAILABLE",
        message: "Notifications are temporarily unavailable",
      });
    }
    if (result.error) {
      throw new ServiceUnavailableException({
        code: "NOTIFICATIONS_UNAVAILABLE",
        message: "Notifications are temporarily unavailable",
      });
    }

    const data = result.data ?? [];
    const total = result.count ?? data.length;
    return {
      data,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        has_more: query.page * query.limit < total,
      },
    };
  }

  @Post("in-app/:id/read")
  async markRead(@Req() req, @Param("id") id: string) {
    await this.inAppRepo.markAsRead(req.user.publicKey, id);

    const unreadCount = await this.inAppRepo.getUnreadCount(req.user.publicKey);

    return {
      success: true,
      unreadCount,
      syncedAt: new Date().toISOString(),
    };
  }

  @Post("in-app/read")
  async markManyRead(@Req() req, @Body() body: MarkManyReadDto) {
    await this.inAppRepo.markManyAsRead(req.user.publicKey, body.ids);

    const unreadCount = await this.inAppRepo.getUnreadCount(req.user.publicKey);

    return {
      success: true,
      unreadCount,
      syncedAt: new Date().toISOString(),
    };
  }

  @Post("in-app/read-all")
  async markAll(@Req() req) {
    await this.inAppRepo.markAllAsRead(req.user.publicKey);

    const unreadCount = await this.inAppRepo.getUnreadCount(req.user.publicKey);

    return {
      success: true,
      unreadCount,
      syncedAt: new Date().toISOString(),
    };
  }
}
