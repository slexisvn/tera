import { useState } from 'react';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import { navigation, project, ui } from '../content/site';
import { Link } from './Link';

export function Header() {
  const [open, setOpen] = useState(false);
  return <header className="site-header">
    <div className="container header-inner">
      <a className="brand" href="#top" aria-label={project.name}><img src={project.mark} width="30" height="30" alt="" />{project.name}<span className="brand-period">.</span></a>
      <nav className={open ? 'navigation is-open' : 'navigation'} id="navigation" aria-label="Main navigation">
        {navigation.map(item => <a key={item.href} href={item.href} onClick={() => setOpen(false)}>{item.label}</a>)}
      </nav>
      <Link href={project.repository} className="header-github">{ui.github}<ArrowUpRight size={15} /></Link>
      <button type="button" className="icon-button menu-toggle" aria-label={ui.menu} aria-expanded={open} aria-controls="navigation" onClick={() => setOpen(!open)}>{open ? <X size={21} /> : <Menu size={21} />}</button>
    </div>
  </header>;
}
