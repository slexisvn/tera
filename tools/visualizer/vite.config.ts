import { defineConfig } from "vitest/config";
import { teraTestConfig, teraViteConfig } from "../ui/vite.ts";

export default defineConfig({
  ...teraViteConfig({ root: import.meta.dirname, base: "/tera/visualizer/" }),
  test: teraTestConfig(),
});
