import { defineConfig } from "vitest/config";

const shared = { environment: "node", testTimeout: 30000 } as const;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/e2e/**"],
        },
      },
      {
        test: {
          ...shared,
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
        },
      },
    ],
  },
});
