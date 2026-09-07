import { afterEach } from "vitest";

const eventLoopTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

afterEach(eventLoopTurn);
