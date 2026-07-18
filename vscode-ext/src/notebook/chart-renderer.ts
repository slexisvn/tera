import { renderChart } from '../../../notebook/src/chart';
import chartCss from '../../../notebook/src/styles/chart.css';
import { errorMessage } from "../../../notebook/src/types/kernel";
import type { ChartSpec } from "../../../notebook/src/types/notebook";

type RendererOutputItem = {
  json(): ChartSpec;
};

const THEME_CSS = `
.tera-chart-output {
  --text: var(--vscode-editor-foreground, #cccccc);
  --muted: var(--vscode-descriptionForeground, #9aa0a6);
  --border: var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
  --border-strong: var(--vscode-editorWidget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.45)));
  --panel: var(--vscode-editorWidget-background, var(--vscode-editor-background, #1e1e1e));
  --accent: var(--vscode-textLink-foreground, #4f6bed);
  --accent-soft: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.15));
  --shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  --code-font: var(--vscode-editor-font-family, ui-monospace, "SFMono-Regular", monospace);
  color: var(--text);
}
`;

let styleInjected = false;

function injectStyle() {
  if (styleInjected) return;
  const style = document.createElement('style');
  style.textContent = THEME_CSS + chartCss;
  document.head.appendChild(style);
  styleInjected = true;
}

export function activate() {
  return {
    renderOutputItem(item: RendererOutputItem, element: HTMLElement) {
      injectStyle();
      const outer = document.createElement('div');
      outer.className = 'tera-chart-output';
      const host = document.createElement('div');
      outer.appendChild(host);
      element.replaceChildren(outer);
      try {
        renderChart(host, item.json());
      } catch (err) {
        host.textContent = 'chart render error: ' + errorMessage(err);
      }
    },
  };
}
