"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  fetchInAppNotifications,
  markAllInAppNotificationsAsRead,
  markInAppNotificationAsRead,
  NOTIFICATION_STORAGE_KEY,
  sortNotifications,
  type StoredNotification,
} from "@/lib/notifications";
import { resolveAuthenticatedPublicKey } from "@/lib/publicKey";

type NotificationCenterContextValue = {
  notifications: StoredNotification[];
  unreadCount: number;
  markAsRead: (id: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
};

const NotificationCenterContext =
  createContext<NotificationCenterContextValue | null>(null);

export function NotificationCenterProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [notifications, setNotifications] = useState<StoredNotification[]>(
    [],
  );
  const [hasHydrated, setHasHydrated] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const refreshFromBackend = useCallback(async () => {
    const publicKey = resolveAuthenticatedPublicKey();
    if (!publicKey) return;

    const result = await fetchInAppNotifications(publicKey);
    setNotifications(result.notifications);
    setUnreadCount(result.unreadCount);
  }, []);

  useEffect(() => {
    try {
      const storedValue = window.localStorage.getItem(NOTIFICATION_STORAGE_KEY);

      if (storedValue) {
        const parsedValue = JSON.parse(storedValue) as StoredNotification[];
        setNotifications(sortNotifications(parsedValue));
        setUnreadCount(
          parsedValue.filter((notification) => !notification.readAt).length,
        );
      }
    } catch (error) {
      console.error("Unable to restore notifications", error);
    } finally {
      setHasHydrated(true);
    }

    void refreshFromBackend().catch(() => {
      // The cached notifications are the offline fallback.
    });
  }, [refreshFromBackend]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshFromBackend().catch(() => {});
    }, 30_000);

    return () => window.clearInterval(interval);
  }, [refreshFromBackend]);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    window.localStorage.setItem(
      NOTIFICATION_STORAGE_KEY,
      JSON.stringify(notifications),
    );
  }, [hasHydrated, notifications]);

  const value = useMemo<NotificationCenterContextValue>(
    () => ({
      notifications,
      unreadCount,
      markAsRead: async (id: string) => {
        setNotifications((currentNotifications) => {
          const nextNotifications = sortNotifications(
            currentNotifications.map((notification) =>
              notification.id === id && notification.readAt === null
                ? { ...notification, readAt: new Date().toISOString() }
                : notification,
            ),
          );
          setUnreadCount(
            nextNotifications.filter((notification) => !notification.readAt)
              .length,
          );
          return nextNotifications;
        });

        const publicKey = resolveAuthenticatedPublicKey();
        if (publicKey) {
          try {
            const response = await markInAppNotificationAsRead(publicKey, id);
            setUnreadCount(response.unreadCount);
          } catch {
            // Keep the optimistic local state when offline.
          }
        }
      },
      markAllAsRead: async () => {
        setNotifications((currentNotifications) => {
          const nextNotifications = sortNotifications(
            currentNotifications.map((notification) =>
              notification.readAt === null
                ? { ...notification, readAt: new Date().toISOString() }
                : notification,
            ),
          );
          setUnreadCount(0);
          return nextNotifications;
        });

        const publicKey = resolveAuthenticatedPublicKey();
        if (publicKey) {
          try {
            const response = await markAllInAppNotificationsAsRead(publicKey);
            setUnreadCount(response.unreadCount);
          } catch {
            // Keep the optimistic local state when offline.
          }
        }
      },
    }),
    [notifications, unreadCount],
  );

  return (
    <NotificationCenterContext.Provider value={value}>
      {children}
    </NotificationCenterContext.Provider>
  );
}

export function useNotificationCenter() {
  const context = useContext(NotificationCenterContext);

  if (!context) {
    throw new Error(
      "useNotificationCenter must be used inside NotificationCenterProvider.",
    );
  }

  return context;
}
