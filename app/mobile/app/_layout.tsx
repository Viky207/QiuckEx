import {
  ThemeProvider,
  type Theme as NavigationTheme,
} from "@react-navigation/native";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import * as SystemUI from "expo-system-ui";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
// Ensure web build or Expo web uses the local backend during development
if (typeof document !== "undefined" && !(globalThis as any).API_BASE_URL) {
  // Expo web typically runs on localhost; ensure the app hits the backend on port 4000
  (globalThis as any).API_BASE_URL = "http://localhost:4000";
}
import "../../src/lib/i18n";
import { OfflineBanner } from "../components/resilience/offline-banner";
import { AppLockOverlay } from "../components/security/app-lock-overlay";
import { SecurityProvider, useSecurity } from "../hooks/use-security";
import { NotificationProvider } from "../components/notifications/NotificationContext";
import ToastNotification from "../components/notifications/ToastNotification";
import { usePaymentListener } from "../hooks/usePaymentListener";
import { useOnboarding } from "../hooks/useOnboarding";
import { WalletProvider } from "../hooks/useWalletContext";
import { NetworkGuardProvider } from "../contexts/NetworkGuardContext";
import { EnvironmentProvider } from "../contexts/EnvironmentContext";
import { SessionProvider } from "../contexts/SessionContext";
import { GlobalNetworkBanner } from "../components/wallet/GlobalNetworkBanner";
import { WalletSyncBridge } from "../components/wallet/WalletSyncBridge";

import { resolveDeepLink, type DeepLinkRoute } from "@/utils/deep-link-routing";
import {
  routeFromNotificationResponse,
  parsePushNotificationPayload,
  routeFromPushPayload,
} from "../services/notification-routing";

// ── Theme System v2 ──────────────────────────────────────────────────────────
import { QuickExThemeProvider, useTheme } from "../src/theme/ThemeContext";
import { invalidateOldCache } from "../services/cache";

function useDeepLinkHandler(
  onRoute: (route: DeepLinkRoute) => void,
  onError: (message: string, url: string) => void,
) {
  useEffect(() => {
    function handleURL(event: { url: string }) {
      const result = resolveDeepLink(event.url);

      if ('route' in result) {
        onRoute(result.route);
        return;
      }

      if ('error' in result) {
        onError(result.error, event.url);
      }
    }

    const subscription = Linking.addEventListener('url', handleURL);

    // Handle cold-start deep link
    Linking.getInitialURL().then((url: string | null) => {
      if (url) handleURL({ url });
    });

    return () => subscription.remove();
  }, [onError, onRoute]);
}

function useNotificationTapRouting(onRoute: (route: DeepLinkRoute) => void) {
  useEffect(() => {
    function routeResponse(response: Notifications.NotificationResponse | null | undefined) {
      routeFromNotificationResponse({ push: (route: DeepLinkRoute) => onRoute(route) } as any, response);
    }

    Notifications.getLastNotificationResponseAsync()
      .then(routeResponse)
      .catch(() => {});

    const subscription = Notifications.addNotificationResponseReceivedListener(
      routeResponse,
    );

    return () => subscription.remove();
  }, [onRoute]);
}

function DevPoller() {
  // demo public key used by send_test_payment.js
  const demo = "GAMOSFOKEYHFDGMXIEFEYBUYK3ZMFYN3PFLOTBRXFGBFGRKBKLQSLGLP";
  // call the hook so polling starts. Hook internally is a no-op in prod.
  usePaymentListener(demo);
  return null;
}

export default function RootLayout() {
  useEffect(() => {
    void invalidateOldCache();
  }, []);

  return (
    <QuickExThemeProvider>
      <ThemeBridge />
    </QuickExThemeProvider>
  );
}

/**
 * Bridges our token-based theme into React Navigation's ThemeProvider
 * so that Stack/Tab navigators inherit the correct colours.
 */
function ThemeBridge() {
  const { theme, isDark } = useTheme();

  useEffect(() => {
    if (Platform.OS === "web") return;
    void SystemUI.setBackgroundColorAsync(theme.background).catch(() => {});
  }, [theme.background]);

  const navTheme: NavigationTheme = useMemo(
    () => ({
      dark: isDark,
      colors: {
        primary: theme.primary,
        background: theme.background,
        card: theme.headerBg,
        text: theme.textPrimary,
        border: theme.border,
        notification: theme.status.error,
      },
      fonts: {
        regular: { fontFamily: 'System', fontWeight: '400' as const },
        medium: { fontFamily: 'System', fontWeight: '500' as const },
        bold: { fontFamily: 'System', fontWeight: '700' as const },
        heavy: { fontFamily: 'System', fontWeight: '800' as const },
      },
    }),
    [theme, isDark],
  );

  return (
    <ThemeProvider value={navTheme}>
      <EnvironmentProvider>
        <SecurityProvider>
        <WalletProvider>
          <NetworkGuardProvider expectedNetwork="testnet">
            <SessionProvider>
              <NotificationProvider>
              <GlobalNetworkBanner />
              <WalletSyncBridge />
              {/* Dev-only global poller: ensures polling runs on web during development
                even if the wallet screen isn't active. */}
              {typeof process !== 'undefined' && process.env.NODE_ENV !== "production" ? (
                // start polling for demo address used by send_test_payment.js
                // eslint-disable-next-line react/jsx-no-useless-fragment
                <DevPoller />
              ) : null}
              <AppShell />
              <ToastNotification />
              </NotificationProvider>
            </SessionProvider>
          </NetworkGuardProvider>
        </WalletProvider>
      </SecurityProvider>
      </EnvironmentProvider>
      <StatusBar style={isDark ? "light" : "dark"} />
    </ThemeProvider>
  );
}

function AppShell() {
  const router = useRouter();
  const { isAppLocked, isReady, settings, unlockApp, getSessionExplanation } = useSecurity();
  const { isLoading: onboardingLoading, hasCompletedOnboarding } = useOnboarding();
  const [pendingDeepLink, setPendingDeepLink] = useState<DeepLinkRoute | null>(null);
  const [pendingLinkError, setPendingLinkError] = useState<{ message: string; url: string } | null>(null);

  // A deep link that resolves to a payment route should bypass onboarding so
  // recipients arriving from a shared payment link land directly on the flow.
  const isPaymentDeepLink = (route: DeepLinkRoute | null): boolean => {
    if (!route) return false;
    const pathname = route.pathname ?? '';
    return pathname.startsWith('/pay') || pathname.startsWith('/claim');
  };

  const canRouteDeepLink =
    !onboardingLoading && (hasCompletedOnboarding || isPaymentDeepLink(pendingDeepLink));

  useEffect(() => {
    if (!canRouteDeepLink) return;

    if (pendingDeepLink) {
      router.push({
        pathname: pendingDeepLink.pathname,
        params: pendingDeepLink.params,
      });
      setPendingDeepLink(null);
      setPendingLinkError(null);
      return;
    }

    if (pendingLinkError) {
      router.replace({
        pathname: '/link-error',
        params: {
          message: pendingLinkError.message,
          url: pendingLinkError.url,
        },
      });
      setPendingLinkError(null);
    }
  }, [canRouteDeepLink, pendingDeepLink, pendingLinkError, router]);

  const enqueueRoute = useCallback(
    (route: DeepLinkRoute) => {
      if (canRouteDeepLink || isPaymentDeepLink(route)) {
        router.push({ pathname: route.pathname, params: route.params });
        return;
      }
      setPendingDeepLink(route);
      setPendingLinkError(null);
    },
    [canRouteDeepLink, router],
  );

  const enqueueError = useCallback(
    (message: string, url: string) => {
      if (canRouteDeepLink) {
        router.replace({
          pathname: '/link-error',
          params: { message, url },
        });
        return;
      }
      setPendingLinkError({ message, url });
      setPendingDeepLink(null);
    },
    [canRouteDeepLink, router],
  );

  useDeepLinkHandler(enqueueRoute, enqueueError);
  useNotificationTapRouting(enqueueRoute);

  if (onboardingLoading) {
    return null; // Show loading screen while checking onboarding status
  }

  return (
    <>
      <OfflineBanner />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
      </Stack>
      {isReady && isAppLocked ? (
        <AppLockOverlay
          settings={settings}
          onUnlock={unlockApp}
          getSessionExplanation={getSessionExplanation}
        />
      ) : null}
    </>
  );
}
