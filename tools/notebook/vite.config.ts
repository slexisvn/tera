import { teraTestConfig, teraViteConfig } from "../ui/vite.ts";
import { defineConfig } from "vitest/config";

export default defineConfig({
  ...teraViteConfig({ root: import.meta.dirname, base: "/tera/" }),
  test: teraTestConfig("jsdom"),
});
