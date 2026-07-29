import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const notebookRoot = import.meta.dirname;
const repoRoot = resolve(notebookRoot, "..");

export default defineConfig({
  base: "/tera/",
  root: notebookRoot,
  publicDir: false,
  plugins: [react()],
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
