import React from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Clipboard,
} from "react-native";
import { useTranslation } from "react-i18next";
import type { TransactionItem as TransactionItemType } from "../types/transaction";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../src/theme/ThemeContext";

interface Props {
  item: TransactionItemType;
  /** The connected account ID used to determine payment direction */
  accountId: string;
}

function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  return d.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatAsset(asset: string): string {
  // If asset is "CODE:ISSUER" → show "CODE"
  const colonIdx = asset.indexOf(":");
  return colonIdx === -1 ? asset : asset.slice(0, colonIdx);
}

function getIssuer(asset: string): string | null {
  const colonIdx = asset.indexOf(":");
  if (colonIdx === -1) return null;
  const issuer = asset.slice(colonIdx + 1).trim();
  return issuer.length > 0 ? issuer : null;
}

function shortenHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-6)}`;
}

function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function TransactionItem({ item }: Props) {
  const { i18n } = useTranslation();
  const { theme } = useTheme();
  const router = useRouter();
  const assetLabel = formatAsset(item.asset);
  const issuer = getIssuer(item.asset);
  // Assets without a known/verified issuer are treated as unverified so users
  // can distinguish them from trusted assets without relying on color alone.
  const isUnverified = issuer !== null && item.verified !== true;
  const hasAddresses = Boolean(item.source || item.destination);
  const formattedAmount = formatNumber(
    parseFloat(item.amount),
    i18n.language || "en",
  );
  const isSent = item.direction === "sent";

  const handlePress = () => {
    router.push({
      pathname: `/transaction/${item.pagingToken}`,
      params: {
        id: item.pagingToken,
        amount: item.amount,
        asset: item.asset,
        memo: item.memo || "",
        timestamp: item.timestamp,
        txHash: item.txHash,
        source: item.source || "",
        destination: item.destination || "",
        status: item.status || "Success",
      },
    });
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      activeOpacity={0.7}
      style={[
        styles.row,
        {
          borderBottomColor: theme.border,
          backgroundColor: theme.surfaceElevated,
        },
      ]}
    >
      {/* Left: direction icon + asset */}
      <View
        style={[
          styles.iconWrap,
          { backgroundColor: isSent ? theme.surface : theme.surface },
        ]}
      >
        {item.direction ? (
          <Ionicons
            name={isSent ? "arrow-up" : "arrow-down"}
            size={20}
            color={isSent ? "#e74c3c" : "#27ae60"}
          />
        ) : (
          <Text style={[styles.assetIcon, { color: theme.textPrimary }]}>
            {assetLabel.slice(0, 3)}
          </Text>
        )}
      </View>

      {/* Middle: asset name, direction label, memo, date */}
      <View style={styles.middle}>
        <View style={styles.assetRow}>
          <Text style={[styles.assetName, { color: theme.textPrimary }]}>
            {assetLabel}
          </Text>
          {item.direction ? (
            <Text
              style={[
                styles.directionLabel,
                { color: isSent ? "#e74c3c" : "#27ae60" },
              ]}
            >
              {isSent ? "Sent" : "Received"}
            </Text>
          ) : null}
          {isUnverified ? (
            <View
              style={[styles.unverifiedBadge, { borderColor: theme.border }]}
              accessible
              accessibilityRole="text"
              accessibilityLabel={`Unverified asset. Issuer ${issuer}`}
            >
              <Ionicons
                name="alert-circle-outline"
                size={12}
                color={theme.textSecondary}
              />
              <Text
                style={[
                  styles.unverifiedBadgeText,
                  { color: theme.textSecondary },
                ]}
              >
                Unverified
              </Text>
            </View>
          ) : null}
        </View>
        {issuer ? (
          <Text
            style={[styles.issuer, { color: theme.textSecondary }]}
            numberOfLines={1}
            ellipsizeMode="middle"
            accessibilityLabel={`Issuer ${issuer}`}
          >
            Issuer: {issuer}
          </Text>
        ) : null}
        {item.memo ? (
          <Text
            style={[styles.memo, { color: theme.textSecondary }]}
            numberOfLines={1}
          >
            {item.memo}
          </Text>
        ) : null}
        <Text style={[styles.txHash, { color: theme.textMuted }]}>
          {shortenHash(item.txHash)}
        </Text>
        {hasAddresses ? (
          <Text
            style={[styles.address, { color: theme.textSecondary }]}
            numberOfLines={1}
          >
            {shortenAddress(item.source)} → {shortenAddress(item.destination)}
          </Text>
        ) : null}
        <Text style={[styles.date, { color: theme.textMuted }]}>
          {formatDate(item.timestamp, i18n.language || "en")}
        </Text>
      </View>

      {/* Right: amount with sign */}
      <View style={styles.right}>
        <Text
          style={[styles.amount, { color: isSent ? "#e74c3c" : "#27ae60" }]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {isSent ? "−" : "+"}
          {formattedAmount}
        </Text>
        <Text style={[styles.assetCode, { color: theme.textSecondary }]}>
          {assetLabel}
        </Text>
        <Ionicons
          name="chevron-forward"
          size={16}
          color={theme.textMuted}
          style={{ marginTop: 4 }}
        />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  assetIcon: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  middle: {
    flex: 1,
    gap: 2,
  },
  assetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  assetName: {
    fontSize: 15,
    fontWeight: "600",
  },
  directionLabel: {
    fontSize: 11,
    fontWeight: "600",
  },
  unverifiedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  unverifiedBadgeText: {
    fontSize: 10,
    fontWeight: "600",
  },
  issuer: {
    fontSize: 11,
    fontFamily: "monospace",
  },
  memo: {
    fontSize: 13,
  },
  txHash: {
    fontSize: 11,
    fontFamily: "monospace",
  },
  address: {
    fontSize: 11,
    fontFamily: "monospace",
  },
  date: {
    fontSize: 12,
    marginTop: 1,
  },
  right: {
    alignItems: "flex-end",
    marginLeft: 8,
    maxWidth: 110,
  },
  amount: {
    fontSize: 15,
    fontWeight: "700",
  },
  assetCode: {
    fontSize: 12,
    marginTop: 2,
  },
});
