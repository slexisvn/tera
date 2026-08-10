import { describe, it, expect } from "vitest";
import { DataFrame } from "@slexisvn/query-engine";
import { backtestConfig, resultToTera } from "../../../src/runtime/domain/quant-builtins.js";

type Frame = { columns(): string[]; collect(): Promise<Array<Record<string, unknown>>> };
type Result = { metrics: unknown; equity: Frame; weights: unknown; port_returns: Frame };

const runResult = (equity: number[], portReturns: number[]) => ({
  equity,
  portReturns,
  weights: [[0.5, 0.5]],
  turnover: 0.25,
  metrics: { sharpe: 1.5, maxDrawdown: 0.1 },
});

describe("backtestConfig", () => {
  it("maps the snake_case options onto their camelCase config keys", () => {
    const config = backtestConfig({
      cost: 0.001,
      max_leverage: 2,
      start: 10,
      periods_per_year: 252,
      folds: 4,
      min_train_fraction: 0.6,
    });

    expect(config).toEqual({
      cost: 0.001,
      maxLeverage: 2,
      start: 10,
      periodsPerYear: 252,
      folds: 4,
      minTrainFraction: 0.6,
    });
  });

  it("keeps strategy options out of the config", () => {
    const config = backtestConfig({
      signal: "momentum",
      portfolio: "long_short",
      lookback: 63,
      fraction: 0.2,
      asset_columns: ["a", "b"],
      cost: 0.0015,
    });

    expect(config).toEqual({ cost: 0.0015 });
  });

  it("omits keys that were not supplied rather than defaulting them", () => {
    expect(backtestConfig({})).toEqual({});
    expect(backtestConfig({ cost: 0 })).toEqual({ cost: 0 });
  });

  it("does not treat an explicit zero or false as absent", () => {
    expect(backtestConfig({ start: 0, max_leverage: 0 })).toEqual({ start: 0, maxLeverage: 0 });
  });
});

describe("resultToTera", () => {
  const shaped = () => resultToTera(runResult([1, 1.1, 1.2], [0.0, 0.1, 0.09])) as Result;

  it("exposes the metrics record untouched", () => {
    expect(shaped().metrics).toEqual({ sharpe: 1.5, maxDrawdown: 0.1 });
  });

  it("passes the raw weights through", () => {
    expect(shaped().weights).toEqual([[0.5, 0.5]]);
  });

  it("wraps equity as a DataFrame with an equity column", async () => {
    const equity = shaped().equity;
    expect(equity).toBeInstanceOf(DataFrame);
    expect(equity.columns()).toEqual(["equity"]);
    expect(await equity.collect()).toEqual([{ equity: 1 }, { equity: 1.1 }, { equity: 1.2 }]);
  });

  it("wraps port returns under the snake_case key with a port_return column", async () => {
    const result = shaped();
    expect(result.port_returns).toBeInstanceOf(DataFrame);
    expect(result.port_returns.columns()).toEqual(["port_return"]);
    expect(await result.port_returns.collect()).toEqual([
      { port_return: 0.0 },
      { port_return: 0.1 },
      { port_return: 0.09 },
    ]);
  });

  it("does not expose the camelCase portReturns key", () => {
    expect(shaped()).not.toHaveProperty("portReturns");
  });

  it("keeps the two frames the same length as their source series", async () => {
    const result = resultToTera(runResult([1, 2], [0.1, 0.2])) as Result;
    expect(await result.equity.collect()).toHaveLength(2);
    expect(await result.port_returns.collect()).toHaveLength(2);
  });
});
