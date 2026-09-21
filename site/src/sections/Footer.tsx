import { ArrowUp, ArrowUpRight } from 'lucide-react';
import { closing, links, project, ui } from '../content/site';
import { InstallCommand } from '../components/InstallCommand';
import { Link } from '../components/Link';

export function Footer() {
  return <><section className="closing"><p className="eyebrow">{closing.eyebrow}</p><h2>{closing.title}</h2><p>{closing.description}</p><InstallCommand /><Link href={links.examples} className="text-link">{closing.examples}<ArrowUpRight size={16} /></Link></section>
    <footer className="site-footer"><div className="footer-brand"><a className="brand" href="#top"><img src={project.mark} width="28" height="28" alt="" />{project.name}<span className="brand-period">.</span></a><span>{closing.footer}</span></div><div className="footer-links"><Link href={links.docs}>{ui.docs}</Link><Link href={project.repository}>{ui.github}</Link><a href="#top" className="icon-button" title={closing.top} aria-label={closing.top}><ArrowUp size={18} /></a></div></footer></>;
}
