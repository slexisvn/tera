import { useState, type KeyboardEvent } from "react";
import { Braces, FileCode2, ArrowUpRight } from "lucide-react";
import { examples, ui } from "../content/site";
import { Code } from "../components/Code";
import { CopyButton } from "../components/CopyButton";
import { Link } from "../components/Link";

export function ExampleExplorer() {
  const [active, setActive] = useState(0);
  const example = examples[active];

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % examples.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + examples.length) % examples.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = examples.length - 1;
    else return;
    event.preventDefault();
    setActive(next);
    document.getElementById(`tab-${examples[next].id}`)?.focus();
  }

  return (
    <section
      id="playground"
      className="example-explorer"
      aria-label={ui.examples}
    >
      <div className="explorer-toolbar">
        <div className="window-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="example-tabs" role="tablist" aria-label={ui.examples}>
          {examples.map((item, index) => (
            <button
              role="tab"
              type="button"
              id={`tab-${item.id}`}
              aria-selected={active === index}
              aria-controls="example-panel"
              tabIndex={active === index ? 0 : -1}
              key={item.id}
              onClick={() => setActive(index)}
              onKeyDown={(event) => navigate(event, index)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <Braces className="toolbar-icon" size={17} aria-hidden="true" />
      </div>
      <div
        className="explorer-body"
        role="tabpanel"
        id="example-panel"
        aria-labelledby={`tab-${example.id}`}
        tabIndex={0}
        key={example.id}
      >
        <div className="explorer-code">
          <div className="file-label">
            <span>
              <FileCode2 size={14} />
              {example.filename}
            </span>
            <CopyButton value={example.code} />
          </div>
          <Code value={example.code} numbered animated />
        </div>
        <div className="explorer-insight">
          <span className="eyebrow">{example.outputLabel ?? ui.output}</span>
          <pre className="example-output">{example.output}</pre>
          <div className="insight-copy">
            <h2>{example.title}</h2>
            <p>{example.description}</p>
            <Link href={example.source} className="text-link">
              {ui.source}
              <ArrowUpRight size={15} />
            </Link>
          </div>
        </div>
      </div>
      <div className="explorer-status">
        <span>
          <span className="status-dot" />
          Tera · static preview
        </span>
        <span>
          UTF-8<span className="status-divider">/</span>
          {example.filename}
        </span>
      </div>
    </section>
  );
}
