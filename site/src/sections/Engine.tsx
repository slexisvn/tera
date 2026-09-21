import { ArrowRight, ArrowUpRight, Workflow, Terminal } from 'lucide-react';
import { engine, links } from '../content/site';
import { SectionHeading } from '../components/SectionHeading';
import { Link } from '../components/Link';
import { CopyButton } from '../components/CopyButton';

export function Engine() {
  return <section className="section engine-section" id="engine">
    <SectionHeading {...engine} />
    <div className="engine-stages">{engine.stages.map((stage, index) => <article className="engine-stage" key={stage.name}><div className="stage-number"><span>0{index + 1}</span>{index < engine.stages.length - 1 && <ArrowRight size={19} aria-hidden="true" />}</div><p className="eyebrow">{stage.tag}</p><h3>{stage.name}</h3><p>{stage.text}</p></article>)}</div>
    <div className="aot-command"><Terminal size={18} /><code>{engine.command}</code><CopyButton value={engine.command} /><span>{engine.note}</span></div>
    <Link href={links.visualizer} className="visualizer-link"><Workflow size={25} /><div><h3>{engine.visualizer}</h3><p>{engine.visualizerDescription}</p></div><ArrowUpRight size={22} /></Link>
  </section>;
}
