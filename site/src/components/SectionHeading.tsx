type HeadingProps = { eyebrow: string; title: string; description: string };

export function SectionHeading({ eyebrow, title, description }: HeadingProps) {
  return <header className="section-heading">
    <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>
    <p className="section-description">{description}</p>
  </header>;
}
