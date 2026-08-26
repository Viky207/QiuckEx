import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

const API_BASE_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  process.env["EXPO_PUBLIC_API_URL"] ??
  "http://localhost:3000";

let handlerConfigured = false;

export function configurePushNotifications(): void {
  if (Platform.OS === "web") return;
  if (handlerConfigured) return;
  handlerConfigured = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

export async function registerForPushNotifications(
  publicKey: string,
): Promise<string | null> {
  configurePushNotifications();

  if (Platform.OS === "web") return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#6366F1",
    });
  }

  const current = await Notifications.getPermissionsAsync();
  let permissions = current;
  if (!permissions.granted) {
    permissions = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
  }

  if (!permissions.granted) return null;

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  )).data;

  const response = await fetch(
    `${API_BASE_URL.replace(/\/$/, "")}/notifications/preferences/${encodeURIComponent(publicKey)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        channel: "push",
        pushToken: token,
        enabled: true,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Push notification registration failed (${response.status})`);
  }

  return token;
}