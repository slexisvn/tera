import { renderChart } from './chart/index.js';
import chartCss from './chart/chart.css';

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
    renderOutputItem(item, element) {
      injectStyle();
      const outer = document.createElement('div');
      outer.className = 'tera-chart-output';
      const host = document.createElement('div');
      outer.appendChild(host);
      element.replaceChildren(outer);
      try {
        renderChart(host, item.json());
      } catch (err) {
        host.textContent = 'chart render error: ' + (err && err.message ? err.message : String(err));
      }
    },
  };
}
