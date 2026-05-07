import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

const obsidianJsonConfig = obsidianmd.configs.recommended.find((config) => config.language === "json/json");

export default defineConfig([
  {
    ignores: ["dist/**", ".test-dist/**", "node_modules/**"],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["manifest.json"],
    plugins: obsidianJsonConfig?.plugins,
    language: "json/json",
    rules: {
      "no-irregular-whitespace": "off",
      "obsidianmd/validate-manifest": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/unbound-method": "error",
      "obsidianmd/ui/sentence-case": "error",
    },
  },
]);
