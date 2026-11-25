/**
 * Design tokens — single TypeScript entry point for colours, typography and
 * spacing. Values are read from packages/design-tokens/tokens.json, the same
 * source tailwind.config.ts consumes, so tokens and Tailwind classes can never
 * drift apart.
 */
import tokens from "../../../packages/design-tokens/tokens.json";

export const colors = {
  primary: tokens.color.brand.primary,
  secondary: tokens.color.brand.secondary,
  destructive: tokens.color.brand.destructive,
  muted: tokens.color.brand.muted,
  neutral: tokens.color.neutral,
} as const;

export const typography = {
  fontSize: tokens.fontSize,
  fontWeight: tokens.fontWeight,
} as const;

export const spacing = tokens.spacing;
export const borderRadius = tokens.borderRadius;

/**
 * Visual treatment for unverified assets (#593).
 *
 * The badge must remain distinguishable without relying on colour alone, so
 * these tokens are paired with a text label and icon in the component. The
 * foreground/background pair is chosen to meet WCAG AA contrast for normal
 * text, and the border keeps the badge visible against both light and dark
 * surfaces.
 */
export const unverifiedAsset = {
  badge: {
    background: tokens.color.unverifiedAsset?.badge?.background ?? "#FFF4E5",
    foreground: tokens.color.unverifiedAsset?.badge?.foreground ?? "#7A3E00",
    border: tokens.color.unverifiedAsset?.badge?.border ?? "#B25E00",
  },
  icon: {
    color: tokens.color.unverifiedAsset?.icon?.color ?? "#7A3E00",
  },
} as const;

export const designTokens = {
  colors,
  typography,
  spacing,
  borderRadius,
  unverifiedAsset,
} as const;
export type DesignTokens = typeof designTokens;
export default designTokens;