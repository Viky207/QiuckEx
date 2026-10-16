import Constants from "expo-constants";

/**
 * Low-level client for backend in-app notification read-state APIs.
 * Set EXPO_PUBLIC_API_URL in your .env file.
 */
const API_BASE_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  process.env["EXPO_PUBLIC_API_URL"] ??
  "http://localhost:4000";

export interface InAppNotificationDto {
  id: string;
  publicKey: string;
  eventType: string;
  eventId: string;
  title: string;
  body: string;
  read: boolean;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface FetchInAppOptions {
  page?: number;
  limit?: number;
}

export interface InAppNotificationListResponse {
  data: InAppNotificationDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    has_more: boolean;
  };
}

export class InAppNotificationApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "InAppNotificationApiError";
  }
}

function getApiBaseUrl() {
  return API_BASE_URL.replace(/\/$/, "");
}

async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new InAppNotificationApiError(
      "NOTIFICATION_DEPENDENCY_UNAVAILABLE",
      "Network request failed. Check your connection and try again.",
    );
  }

  if (!response.ok) {
    let code = "NOTIFICATION_REQUEST_FAILED";
    let message = `Server error (${response.status})`;
    try {
      const body = (await response.json()) as {
        code?: unknown;
        message?: unknown;
      };
      if (typeof body.code === "string") code = body.code;
      if (typeof body.message === "string") message = body.message;
    } catch {
      // keep status-code message
    }
    throw new InAppNotificationApiError(code, message, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  if (!text) {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new InAppNotificationApiError(
      "NOTIFICATION_RESPONSE_MALFORMED",
      "The notification service returned an invalid response.",
      response.status,
    );
  }
}

function isNotification(value: unknown): value is InAppNotificationDto {
  if (!value || typeof value !== "object") return false;
  const notification = value as Record<string, unknown>;
  return (
    typeof notification.id === "string" &&
    typeof notification.publicKey === "string" &&
    typeof notification.eventType === "string" &&
    typeof notification.eventId === "string" &&
    typeof notification.title === "string" &&
    typeof notification.body === "string" &&
    typeof notification.read === "boolean" &&
    typeof notification.createdAt === "string" &&
    !Number.isNaN(Date.parse(notification.createdAt)) &&
    (notification.metadata === undefined ||
      notification.metadata === null ||
      (typeof notification.metadata === "object" &&
        !Array.isArray(notification.metadata)))
  );
}

function parseNotificationList(
  payload: unknown,
  expectedPage: number,
  expectedLimit: number,
): InAppNotificationListResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw malformedResponse();
  }
  const envelope = payload as Record<string, unknown>;
  const pagination = envelope.pagination as
    | Record<string, unknown>
    | undefined;
  if (
    !Array.isArray(envelope.data) ||
    !envelope.data.every(isNotification) ||
    envelope.data.length > expectedLimit ||
    !pagination ||
    pagination.page !== expectedPage ||
    pagination.limit !== expectedLimit ||
    !Number.isInteger(pagination.total) ||
    (pagination.total as number) < envelope.data.length ||
    typeof pagination.has_more !== "boolean" ||
    pagination.has_more !==
      expectedPage * expectedLimit < (pagination.total as number)
  ) {
    throw malformedResponse();
  }
  return payload as InAppNotificationListResponse;
}

function malformedResponse(): InAppNotificationApiError {
  return new InAppNotificationApiError(
    "NOTIFICATION_RESPONSE_MALFORMED",
    "The notification service returned an invalid response.",
  );
}

/**
 * Fetches paginated in-app notifications for a Stellar account.
 */
export async function fetchInAppNotifications(
  publicKey: string,
  options: FetchInAppOptions = {},
): Promise<InAppNotificationListResponse> {
  const { page = 1, limit = 50 } = options;
  const params = new URLSearchParams({
    publicKey,
    page: String(page),
    limit: String(limit),
  });

  const payload = await requestJson<unknown>(
    `/notifications/in-app?${params.toString()}`,
  );
  return parseNotificationList(payload, page, limit);
}

/**
 * Marks a single in-app notification as read on the backend.
 */
export async function markInAppNotificationRead(id: string): Promise<void> {
  await requestJson(`/notifications/in-app/${encodeURIComponent(id)}/read`, {
    method: "POST",
  });
}

/**
 * Marks all in-app notifications as read for a Stellar account.
 */
export async function markAllInAppNotificationsRead(
  publicKey: string,
): Promise<void> {
  const params = new URLSearchParams({ publicKey });
  await requestJson(`/notifications/in-app/read-all?${params.toString()}`, {
    method: "POST",
  });
}

/**
 * Derives unread count from a fetched in-app notification list.
 */
export function countUnreadInAppNotifications(
  notifications: Array<{ read: boolean }>,
): number {
  return notifications.filter((notification) => !notification.read).length;
}
