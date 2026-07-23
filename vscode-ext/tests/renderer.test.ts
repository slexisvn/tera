// @vitest-environment jsdom
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BUNDLE = resolve(import.meta.dirname, "../dist/chart-renderer.mjs");

const SPEC = {
  kind: "tera.notebook.chart",
  type: "line",
  series: [{ name: "s", points: [{ x: 0, y: 1 }, { x: 1, y: 4 }] }],
  pointCount: 2,
  options: { title: "t", zoom: false },
};

describe("chart-renderer bundle", () => {
  it("activates and renders a chart spec into the element", async () => {
    const renderer = (await import(BUNDLE)).activate();
    expect(typeof renderer.renderOutputItem).toBe("function");

    const element = document.createElement("div");
    renderer.renderOutputItem({ json: () => SPEC }, element);

    expect(element.querySelector(".tera-chart-output")).not.toBeNull();
    expect(element.querySelector("svg")).not.toBeNull();
    expect(element.textContent).not.toContain("chart render error");
  });

  it("reports a bad spec instead of throwing", async () => {
    const renderer = (await import(BUNDLE)).activate();

    const element = document.createElement("div");
    renderer.renderOutputItem({ json: () => ({ kind: "nonsense" }) }, element);

    expect(element.textContent).toContain("chart render error");
  });
});
