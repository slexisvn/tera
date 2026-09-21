import { ArrowDown, ArrowUpRight } from 'lucide-react';
import { hero, links } from '../content/site';
import { InstallCommand } from '../components/InstallCommand';
import { Link } from '../components/Link';

export function Hero() {
  return <section className="hero container" aria-labelledby="hero-title">
    <p className="hero-badge"><span className="status-dot" />{hero.badge}</p>
    <h1 id="hero-title">{hero.title}<span>.</span></h1>
    <p className="hero-subtitle">{hero.subtitle}</p>
    <p className="hero-description">{hero.description}</p>
    <div className="hero-actions"><a href="#playground" className="button button-primary">{hero.primary}<ArrowDown size={17} /></a><Link href={links.docs} className="button button-secondary">{hero.secondary}<ArrowUpRight size={17} /></Link></div>
    <InstallCommand />
    <p className="hero-footnote">{hero.footnote}</p>
  </section>;
}
