import { describe, it, expect } from "vitest";
import { Engine } from "../../../../src/index.js";

const native = (source: string) => new Engine().runNative(source);

const garchSetup = [
  "returns = [0.01, -0.02, 0.015, -0.005, 0.012]",
  "params = {omega: 0.000001, alpha: 0.1, beta: 0.85}",
].join("\n");

describe("garch_volatility", () => {
  it("keeps the params object positional when initial_variance is omitted", () => {
    const result = native(`${garchSetup}\ngarch_volatility(returns, params)`) as number[];

    expect(result).toHaveLength(5);
    expect(result.every(Number.isFinite)).toBe(true);
  });

  it("binds named arguments without treating positional objects as options", () => {
    const positional = native(`${garchSetup}\ngarch_volatility(returns, params, 0.0004)`);
    const named = native(`${garchSetup}\ngarch_volatility(returns=returns, params=params, initial_variance=0.0004)`);
    const mixed = native(`${garchSetup}\ngarch_volatility(returns, params, initial_variance=0.0004)`);

    expect(named).toEqual(positional);
    expect(mixed).toEqual(positional);
  });
});
