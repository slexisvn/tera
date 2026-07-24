import { describe, runConfig, sameOutcome } from "./engines.mjs";
const mk = (...lines) => lines.join("\n");
const hot = (expr) => mk(
  "fn f0(p0):",
  `  return ${expr}`,
  "fn run(n):",
  "  last = 0", "  i = 0",
  "  while (i < n):",
  "    i = (i + 1)",
  "    last = f0(i)",
  "  return last",
  "run(1200)",
);
const exprs = [
  "(~ 1e+308)", "(~ 1e308)", "(~ 2147483648)", "(~ 4294967296)", "(~ 1.5)", "(~ (-1e308))",
  "(1e308 | 0)", "(1e308 >> 0)", "(1e308 >>> 0)", "(1e308 & 1)", "(1e308 ^ 0)",
  "(9007199254740992 | 0)", "(1e308 << 1)",
  "(~ p0)", "(1e21 | 0)", "(-1e21 | 0)", "(Infinity | 0)", "(NaN | 0)",
];
for (const expr of exprs) {
  const source = hot(expr);
  const oracle = runConfig("oracle", source);
  const jit = runConfig("jit", source);
  console.log(`${sameOutcome(oracle, jit) ? "    " : "BAD "}${expr.padEnd(24)} oracle=${describe(oracle).padEnd(16)} jit=${describe(jit)}`);
}
