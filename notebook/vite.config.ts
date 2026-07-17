import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const notebookRoot = import.meta.dirname;
const repoRoot = resolve(notebookRoot, "..");

function languageDataPlugin() {
  return {
    name: "tera-language-data",
    writeBundle() {
      const out = resolve(notebookRoot, "dist");
      mkdirSync(out, { recursive: true });
      copyFileSync(resolve(repoRoot, "vscode-ext/language-data.json"), resolve(out, "language-data.json"));
    },
  };
}

export default defineConfig({
  root: notebookRoot,
  publicDir: false,
  plugins: [react(), languageDataPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    fs: {
      allow: [repoRoot, dirname(repoRoot)],
    },
  },
  test: {
    environment: "jsdom",
  },
});
