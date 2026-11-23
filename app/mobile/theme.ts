import tokens from "../../packages/design-tokens/tokens.json";
import {
  MIN_TOUCH_TARGET_SIZE,
  TOUCH_TARGET_SPACING,
  touchTarget,
} from "../../constants/theme";

/**
 * Mobile theme module.
 *
 * Re-exports the shared touch-target and spacing tokens from
 * `constants/theme.ts` so dense settings screens (developer and profile
 * settings) and their components can import them consistently.
 *
 * Accessibility standard for interactive targets (toggles, copy buttons,
 * row actions):
 * - Minimum target size: 44x44 (see `MIN_TOUCH_TARGET_SIZE`).
 * - Minimum spacing between adjacent targets: `TOUCH_TARGET_SPACING`, used
 *   as the row gap so targets never touch.
 * - Targets must not overlap when the user zooms; layouts should rely on the
 *   spacing token rather than fixed offsets so actions reflow instead of
 *   colliding. Secondary information must remain visible (do not hide it to
 *   make room for targets).
 */

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

export {
  MIN_TOUCH_TARGET_SIZE,
  TOUCH_TARGET_SPACING,
  touchTarget,
};

export const theme = {
  colors,
  fontSize,
  fontWeight,
  spacing,
  borderRadius,
  touchTarget,
  minTouchTargetSize: MIN_TOUCH_TARGET_SIZE,
  touchTargetSpacing: TOUCH_TARGET_SPACING,
} as const;

export default theme;