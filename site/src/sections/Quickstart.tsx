import { ArrowRight, ArrowUpRight } from "lucide-react";
import { links, quickstart } from "../content/site";
import { CopyButton } from "../components/CopyButton";
import { Link } from "../components/Link";

export function Quickstart() {
  return (
    <section className="quickstart reveal" id="quickstart" aria-labelledby="quickstart-title">
      <div className="quickstart-heading">
        <div>
          <span className="eyebrow">{quickstart.eyebrow}</span>
          <h2 id="quickstart-title">{quickstart.title}</h2>
        </div>
        <p>{quickstart.description}</p>
      </div>
      <ol className="quickstart-steps">
        {quickstart.steps.map((step) => (
          <li key={step.number}>
            <span className="quickstart-number">{step.number} / 03</span>
            <h3>{step.title}</h3>
            <p>{step.detail}</p>
            <div className="quickstart-snippet">
              <span className="quickstart-file">{step.filename}</span>
              <div className="quickstart-command">
                <code>{step.code}</code>
                <CopyButton value={step.code} label={step.copyLabel} />
              </div>
              {"output" in step && <span className="quickstart-output">→ {step.output}</span>}
            </div>
          </li>
        ))}
      </ol>
      <div className="quickstart-links">
        <a href="#playground" className="text-link">
          {quickstart.next}
          <ArrowRight size={16} aria-hidden="true" />
        </a>
        <Link href={links.docs} className="text-link">
          {quickstart.docs}
          <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
