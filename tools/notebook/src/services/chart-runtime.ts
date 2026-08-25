import type { ChartSpec } from "../types/notebook";

type ChartModule = {
  renderChart(host: HTMLElement, spec: ChartSpec): void | (() => void);
};

const chartModules = import.meta.glob<ChartModule>("../chart/index.ts");

export async function renderNotebookChart(host: HTMLElement, spec: ChartSpec): Promise<void | (() => void)> {
  const load = chartModules["../chart/index.ts"];
  if (!load) throw new Error("Chart renderer is unavailable");
  const module = await load();
  return module.renderChart(host, spec);
}
