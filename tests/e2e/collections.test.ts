import { describe, expect, it } from "vitest";
import { Engine } from "../../src/index.js";
import { taggedToNative } from "../../src/runtime/domain/host.js";

const engineValue = (source: string) => new Engine().run(source);
const run = (source: string) => new Engine().runValue(source).value;
const native = (source: string) => taggedToNative(engineValue(source));

describe("Tera objects and collections", () => {
  it("treats object literals as JS objects and Map as Map", () => {
    expect(run("obj = { a: 1, b: 2 }\nobj.a + obj.b")).toBe(3);
    expect(run("m = Map()\nm.set(\"a\", 7)\nm.get(\"a\")")).toBe(7);
    expect(native("Map().set(\"a\", 1)") instanceof Map).toBe(true);
  });

  it("constructs Set without new and preserves uniqueness", () => {
    expect(run("s = Set()\ns.add(1)\ns.add(1)\ns.add(2)\ns.size")).toBe(2);
  });

  it("uses snake_case intrinsic methods", () => {
    expect(run("\"tera\".to_upper_case()")).toBe("TERA");
    expect(run("[1, 2, 3].find_index(x => x == 2)")).toBe(1);
  });

  it("builds chart specs through named arguments", () => {
    expect(native("chart.line([[0, 1], [1, 3]], x=0, y=1).series[0].points[1].y")).toBe(3);
    expect(native("chart.histogram([1, 2, 2, 3], bins=2).pointCount")).toBe(2);
  });

  it("builds non-empty chart specs from DataFrame columns", () => {
    const spec = native([
      "metrics = DataFrame(epoch=[1, 2, 3, 4], loss=[1.0, 0.72, 0.48, 0.31], val_loss=[1.1, 0.81, 0.6, 0.44])",
      "chart.line(metrics, x=\"epoch\", y=[\"loss\", \"val_loss\"], title=\"Training\")",
    ].join("\n")) as { pointCount: number; series: Array<{ name: string; points: Array<{ x: unknown; y: number }> }> };

    expect(spec.pointCount).toBe(8);
    expect(spec.series.map((series) => series.name)).toEqual(["loss", "val_loss"]);
    expect(spec.series[0]?.points[0]).toEqual({ x: 1, y: 1 });
    expect(spec.series[1]?.points[3]).toEqual({ x: 4, y: 0.44 });
  });
});
