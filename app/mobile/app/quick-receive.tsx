import React, { useMemo } from "react";
import {
  AccessibilityInfo,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Share,
  Alert,
} from "react-native";
import QRCode from "react-native-qrcode-svg";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useTheme } from "../src/theme/ThemeContext";
import { useWallet } from "../hooks/useWallet";

export default function QuickReceiveScreen() {
  const { wallet } = useWallet();
  const { theme } = useTheme();
  const router = useRouter();

  const isConnected = wallet.connected && Boolean(wallet.publicKey);
  const accountIdentifier = wallet.publicKey;

  const truncatedAddress = useMemo(() => {
    if (!accountIdentifier) return "";
    if (accountIdentifier.length <= 12) return accountIdentifier;
    return `${accountIdentifier.slice(0, 6)}...${accountIdentifier.slice(-6)}`;
  }, [accountIdentifier]);

  const receiveLink = useMemo(() => {
    if (!accountIdentifier) return null;
    return `https://quickex.to/${accountIdentifier}`;
  }, [accountIdentifier]);

  const handleCopyLink = async () => {
    if (!receiveLink) return;
    await Clipboard.setStringAsync(receiveLink);
    AccessibilityInfo.announceForAccessibility("Payment link copied to clipboard");
    Alert.alert("Copied", "Link copied to clipboard");
  };

  const handleCopyAddress = async () => {
    if (!accountIdentifier) return;
    await Clipboard.setStringAsync(accountIdentifier);
    AccessibilityInfo.announceForAccessibility("Wallet address copied to clipboard");
    Alert.alert("Copied", "Public key copied to clipboard");
  };

  const handleShare = async () => {
    if (!receiveLink) return;

    AccessibilityInfo.announceForAccessibility("Opening share sheet for payment link");
    await Share.share({
      message: `Send me payment via QuickEx:\n${receiveLink}`,
    });
  };

  const handleConnectWallet = () => {
    router.push("/wallet-connect");
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <Text style={[styles.title, { color: theme.textPrimary }]}>
        Quick Receive
      </Text>

      {!isConnected ? (
        <View style={styles.emptyContainer}>
          <Text style={[styles.warning, { color: theme.textPrimary }]}>
            No wallet connected
          </Text>
          <Text style={[styles.subText, { color: theme.textSecondary }]}>
            Connect your Stellar wallet to display your QR code and start receiving payments.
          </Text>

          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: theme.status.info, marginTop: 24 }]}
            onPress={handleConnectWallet}
            accessibilityRole="button"
            accessibilityLabel="Connect wallet"
            accessibilityHint="Opens the wallet connection screen to connect your Stellar wallet"
          >
            <Text style={[styles.buttonText, { color: theme.buttonPrimaryText }]} allowFontScaling>
              Connect Wallet
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <View style={[styles.badgeContainer, { backgroundColor: theme.chipBg }]}>
            {wallet.walletType ? (
              <Text style={[styles.badgeText, { color: theme.chipText }]}>
                {wallet.walletType.toUpperCase()} • {wallet.network.toUpperCase()}
              </Text>
            ) : null}
          </View>

          <TouchableOpacity
            onPress={handleCopyAddress}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`Wallet address ${truncatedAddress}`}
            accessibilityHint="Copies the public wallet address to the clipboard"
          >
            <Text style={[styles.username, { color: theme.textPrimary }]} allowFontScaling>
              {truncatedAddress}
            </Text>
          </TouchableOpacity>

          {/* QR codes must always be black-on-white for scanner readability */}
          <View style={[styles.qrWrapper, { backgroundColor: theme.qrBackground }]}>
            <QRCode
              value={receiveLink!}
              size={220}
              backgroundColor={theme.qrBackground}
              color={theme.qrForeground}
            />
          </View>

          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: theme.status.info }]}
            onPress={handleCopyLink}
            accessibilityRole="button"
            accessibilityLabel="Copy payment link"
            accessibilityHint="Copies the shareable payment link for this wallet"
          >
            <Text style={[styles.buttonText, { color: theme.buttonPrimaryText }]} allowFontScaling>Copy Link</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.secondaryButton, { backgroundColor: theme.chipBg, marginBottom: 12 }]}
            onPress={handleCopyAddress}
            accessibilityRole="button"
            accessibilityLabel="Copy wallet address"
            accessibilityHint="Copies the public wallet address for this account"
          >
            <Text style={[styles.buttonText, { color: theme.textPrimary }]} allowFontScaling>Copy Address</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.secondaryButton, { backgroundColor: theme.status.success }]}
            onPress={handleShare}
            accessibilityRole="button"
            accessibilityLabel="Share payment link"
            accessibilityHint="Shares the payment link with another app"
          >
            <Text style={[styles.buttonText, { color: theme.buttonPrimaryText }]} allowFontScaling>Share</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 24,
  },
  username: {
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 20,
    fontFamily: "monospace",
  },
  badgeContainer: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 8,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  qrWrapper: {
    padding: 16,
    borderRadius: 16,
    marginBottom: 30,
  },
  primaryButton: {
    width: "100%",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginBottom: 12,
  },
  secondaryButton: {
    width: "100%",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  buttonText: {
    fontWeight: "600",
  },
  emptyContainer: {
    alignItems: "center",
    width: "100%",
    paddingHorizontal: 16,
  },
  warning: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 8,
    textAlign: "center",
  },
  subText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    opacity: 0.8,
  },
});