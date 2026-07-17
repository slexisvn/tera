type DocsPanelProps = {
  onClose: () => void;
};

export function DocsPanel({ onClose }: DocsPanelProps) {
  return (
    <aside id="docs-panel" className="docs-panel" aria-label="Tera documentation">
      <div className="docs-top">
        <div>
          <div className="docs-kicker">Tera docs</div>
          <h2>Reference</h2>
        </div>
        <div className="docs-head-actions">
          <span className="docs-badge">live</span>
          <button id="docs-close" className="docs-close" type="button" title="Close docs" aria-label="Close docs" onClick={onClose}>x</button>
        </div>
      </div>
      <input id="docs-search" className="docs-search" type="search" placeholder="Search tensor, model, DataFrame..." autoComplete="off" />
      <div id="docs-list" className="docs-list" />
    </aside>
  );
}
