import type { Config } from "tailwindcss";
import tokens from "../../packages/design-tokens/tokens.json";

const px = (value: number) => `${value}px`;

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: tokens.color.brand.primary,
        secondary: tokens.color.brand.secondary,
        destructive: tokens.color.brand.destructive,
        muted: tokens.color.brand.muted,
        neutral: Object.fromEntries(
          Object.entries(tokens.color.neutral).map(([key, value]) => [key, value])
        ),
      },
      fontSize: Object.fromEntries(
        Object.entries(tokens.fontSize).map(([key, value]) => [key, px(value)])
      ),
      fontWeight: Object.fromEntries(
        Object.entries(tokens.fontWeight).map(([key, value]) => [key, String(value)])
      ),
      spacing: Object.fromEntries(
        Object.entries(tokens.spacing).map(([key, value]) => [key, px(value)])
      ),
      borderRadius: Object.fromEntries(
        Object.entries(tokens.borderRadius).map(([key, value]) => [key, px(value)])
      ),
    },
  },
  plugins: [],
};

export default config;
