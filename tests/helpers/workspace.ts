import { rmSync } from "node:fs";

export function removeDirectory(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    return;
  }
}
