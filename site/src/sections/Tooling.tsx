import { ArrowUpRight, BookOpen, Code2, Terminal, FileCode2, Table2 } from 'lucide-react';
import { language, links, tooling } from '../content/site';
import { SectionHeading } from '../components/SectionHeading';
import { DataTable } from '../components/DataTable';
import { Code } from '../components/Code';
import { Link } from '../components/Link';

export function Tooling() {
  return <section className="section" id="tooling">
    <SectionHeading {...tooling} />
    <div className="tool-grid">
      <article className="tool tool-notebook"><div className="tool-copy"><BookOpen size={24} /><h3>{tooling.notebook.title}</h3><p>{tooling.notebook.description}</p><Link href={links.notebook} className="text-link">{tooling.notebook.action}<ArrowUpRight size={16} /></Link></div>
        <div className="notebook-preview" aria-label={tooling.notebook.label}><div className="notebook-top"><BookOpen size={15} /><span>{tooling.notebook.filename}</span><span className="status-dot" /></div><div className="notebook-cell"><span className="cell-index">[1]</span><Code value={tooling.notebook.cell} /></div><div className="notebook-output"><Table2 size={14} /><DataTable {...language.dataframe} /></div></div>
      </article>
      <article className="tool tool-editor"><div className="feature-label"><Code2 size={18} />{tooling.extension.label}</div><h3>{tooling.extension.title}</h3><p>{tooling.extension.description}</p><div className="editor-preview"><span className="file-label"><FileCode2 size={13} />{tooling.extension.filename}</span><Code value={tooling.extension.code} annotations={tooling.extension.annotations} /></div><Link href={links.extension} className="text-link">{tooling.extension.action}<ArrowUpRight size={16} /></Link></article>
      <article className="tool tool-cli"><div className="feature-label"><Terminal size={18} />{tooling.cli.label}</div><h3>{tooling.cli.title}</h3><p>{tooling.cli.description}</p><div className="terminal-preview">{tooling.cli.commands.map(command => <div key={command}><span aria-hidden="true">$</span><code>{command}</code></div>)}</div><Link href={links.cli} className="text-link">{tooling.cli.action}<ArrowUpRight size={16} /></Link></article>
    </div>
  </section>;
}
