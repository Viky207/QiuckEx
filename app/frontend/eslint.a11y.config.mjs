// jsx-a11y flat-config override. Merge into eslint.config.mjs, e.g.:
//   import a11yConfig from "./eslint.a11y.config.mjs";
//   const eslintConfig = [...compat.extends(...), ...a11yConfig, { ... }];
// Requires: pnpm add -D eslint-plugin-jsx-a11y
import jsxA11y from "eslint-plugin-jsx-a11y";

const a11yConfig = [
  {
    plugins: { "jsx-a11y": jsxA11y },
    rules: {
      ...jsxA11y.configs.recommended.rules,
      "jsx-a11y/anchor-is-valid": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-role": "error",
      "jsx-a11y/label-has-associated-control": "error",
      "jsx-a11y/no-autofocus": "warn",
      "jsx-a11y/tabindex-no-positive": "error",
    },
  },
];

export default a11yConfig;
