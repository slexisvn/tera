import { ArrowDown, ArrowUpRight } from "lucide-react";
import { hero, links } from "../content/site";
import { InstallCommand } from "../components/InstallCommand";
import { Link } from "../components/Link";
import { stagger } from "../motion";

export function Hero() {
  return (
    <section className="hero container" aria-labelledby="hero-title">
      <div className="hero-glow" aria-hidden="true" />
      <p className="hero-badge hero-enter" style={stagger(0)}>
        <span className="status-dot" />
        {hero.badge}
      </p>
      <h1 id="hero-title" className="hero-enter" style={stagger(1)}>
        {hero.title}
        <span>.</span>
      </h1>
      <p className="hero-subtitle hero-enter" style={stagger(2)}>
        {hero.subtitle}
      </p>
      <p className="hero-description hero-enter" style={stagger(3)}>
        {hero.description}
      </p>
      <div className="hero-actions hero-enter" style={stagger(4)}>
        <a href="#playground" className="button button-primary">
          {hero.primary}
          <ArrowDown size={17} />
        </a>
        <Link href={links.docs} className="button button-secondary">
          {hero.secondary}
          <ArrowUpRight size={17} />
        </Link>
      </div>
      <div className="hero-enter" style={stagger(5)}>
        <InstallCommand />
      </div>
      <p className="hero-footnote hero-enter" style={stagger(6)}>
        {hero.footnote}
      </p>
    </section>
  );
}
