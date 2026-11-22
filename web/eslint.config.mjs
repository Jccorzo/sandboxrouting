// Lint for the site: Next's recommended rules (React, hooks, accessibility, Core Web Vitals)
// plus its TypeScript rules. The root eslint.config.js ignores web/, so each package lints itself.
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/**", "out/**", "node_modules/**", "next-env.d.ts", "src/generated/**", "public/data/**"] },
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];

export default config;
