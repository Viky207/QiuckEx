import tokens from "../../packages/design-tokens/tokens.json";

const px = (value: number) => value;

export const colors = {
  primary: tokens.color.brand.primary,
  secondary: tokens.color.brand.secondary,
  destructive: tokens.color.brand.destructive,
  muted: tokens.color.brand.muted,
  neutral: tokens.color.neutral,
} as const;

export const fontSize = Object.fromEntries(
  Object.entries(tokens.fontSize).map(([key, value]) => [key, px(value)])
) as Record<keyof typeof tokens.fontSize, number>;

export const fontWeight = Object.fromEntries(
  Object.entries(tokens.fontWeight).map(([key, value]) => [key, String(value)])
) as Record<keyof typeof tokens.fontWeight, string>;

export const spacing = Object.fromEntries(
  Object.entries(tokens.spacing).map(([key, value]) => [key, px(value)])
) as Record<keyof typeof tokens.spacing, number>;

export const borderRadius = Object.fromEntries(
  Object.entries(tokens.borderRadius).map(([key, value]) => [key, px(value)])
) as Record<keyof typeof tokens.borderRadius, number>;

export const theme = {
  colors,
  fontSize,
  fontWeight,
  spacing,
  borderRadius,
} as const;

export default theme;
