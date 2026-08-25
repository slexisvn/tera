import { defineConfig } from "vitest/config";
import { teraAliases, teraTestConfig } from "../ui/vite.ts";

export default defineConfig({
  resolve: { alias: teraAliases() },
  test: teraTestConfig(),
});
