/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 *
 * DEPRECATED — prefer `src/theme/tokens.ts` and the `useTheme()` hook.
 * Kept for backwards-compatibility with existing ThemedText / ThemedView.
 */

import { Platform } from 'react-native';
import { LightTheme, DarkTheme } from '../src/theme/tokens';

const tintColorLight = LightTheme.tint;
const tintColorDark = DarkTheme.tint;

/**
 * Unverified-asset visual treatment tokens.
 *
 * Re-exported from `src/theme/tokens` so legacy ThemedText / ThemedView
 * consumers render the same badge treatment as the new components.
 * The treatment never relies on color alone: it pairs a text label and
 * icon with the color, and the explanation is keyboard accessible.
 */
export const UnverifiedAssetColors = {
  light: {
    background: LightTheme.unverifiedBackground,
    border: LightTheme.unverifiedBorder,
    text: LightTheme.unverifiedText,
    icon: LightTheme.unverifiedIcon,
  },
  dark: {
    background: DarkTheme.unverifiedBackground,
    border: DarkTheme.unverifiedBorder,
    text: DarkTheme.unverifiedText,
    icon: DarkTheme.unverifiedIcon,
  },
};

export const Colors = {
  light: {
    text: LightTheme.textPrimary,
    background: LightTheme.background,
    tint: tintColorLight,
    icon: LightTheme.tabIconDefault,
    tabIconDefault: LightTheme.tabIconDefault,
    tabIconSelected: tintColorLight,
    unverified: UnverifiedAssetColors.light,
  },
  dark: {
    text: DarkTheme.textPrimary,
    background: DarkTheme.background,
    tint: tintColorDark,
    icon: DarkTheme.tabIconDefault,
    tabIconDefault: DarkTheme.tabIconDefault,
    tabIconSelected: tintColorDark,
    unverified: UnverifiedAssetColors.dark,
  },
};

/**
 * Minimum interactive target size and spacing for dense screens (issue #604).
 *
 * `minSize` follows the project accessibility standard (44x44 logical pixels,
 * matching WCAG 2.5.5 / Apple HIG). `rowGap` is the minimum vertical spacing
 * between adjacent interactive rows, and `hitSlop` expands small controls
 * (toggles, copy buttons, row actions) without visually enlarging them or
 * hiding secondary information.
 */
export const touchTarget = {
  minSize: 44,
  rowGap: 12,
  hitSlop: 8,
} as const;

/**
 * Returns the minimum size style for an interactive target. Apply to toggles,
 * copy buttons, and row actions so zoomed layouts do not create overlapping
 * actions.
 */
export function touchTargetStyle(): { minWidth: number; minHeight: number } {
  return { minWidth: touchTarget.minSize, minHeight: touchTarget.minSize };
}

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
