import { useEffect, useMemo, useState } from "react";
import { DocBlocks } from "../components/docs/DocBlocks";
import { ReferenceView } from "../components/docs/ReferenceView";
import { GUIDE_CHAPTERS } from "../docs/guide-content";
import { buildReferenceModel } from "../docs/reference";
import { languageData } from "../utils/language-data";
import { navigateTo } from "../utils/hash-route";
import { useTheme } from "../utils/use-theme";

const REFERENCE_ID = "reference";

type NavItem = { id: string; title: string };
type NavGroup = { title: string; items: NavItem[] };

function useScrollSpy(ids: string[]): string {
  const [active, setActive] = useState(ids[0] ?? "");
  const key = ids.join("\0");
  useEffect(() => {
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      const current = ids.find((id) => visible.has(id));
      if (current) setActive(current);
    }, { rootMargin: "-72px 0px -70% 0px" });
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [key]);
  return active;
}

export function DocsPage() {
  const [theme, toggleTheme] = useTheme();
  const referenceModel = useMemo(() => buildReferenceModel(languageData), []);

  const referenceItems = useMemo<NavItem[]>(() => [
    ...referenceModel.chipSections.map((section) => ({ id: section.id, title: section.title })),
    ...referenceModel.categories.map((section) => ({ id: section.id, title: section.title })),
    ...referenceModel.members.map((group) => ({ id: group.id, title: group.name })),
  ], [referenceModel]);

  const groups: NavGroup[] = [
    { title: "Guide", items: GUIDE_CHAPTERS.map((chapter) => ({ id: chapter.id, title: chapter.title })) },
    { title: "Reference", items: [{ id: REFERENCE_ID, title: "Overview" }, ...referenceItems] },
  ];

  const spyIds = useMemo(() => groups.flatMap((group) => group.items.map((item) => item.id)), [referenceItems]);
  const active = useScrollSpy(spyIds);

  const goTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="docs-page">
      <header className="docs-header">
        <button className="docs-brand" type="button" onClick={() => navigateTo("/")} title="Back to notebook">
          <span className="docs-brand-logo">Tera</span>
          <span className="docs-brand-sub">docs</span>
        </button>
        <div className="docs-header-actions">
          <button type="button" onClick={() => navigateTo("/")} title="Open the notebook">Notebook</button>
          <button type="button" onClick={toggleTheme} title="Toggle dark mode">{theme === "dark" ? "Light" : "Dark"}</button>
        </div>
      </header>

      <div className="docs-shell">
        <nav className="docs-nav" aria-label="Documentation">
          {groups.map((group) => (
            <div className="docs-nav-group" key={group.title}>
              <div className="docs-nav-title">{group.title}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`docs-nav-link${active === item.id ? " active" : ""}`}
                  onClick={() => goTo(item.id)}
                >
                  {item.title}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <main className="docs-main">
          <div className="docs-hero">
            <div className="docs-hero-kicker">The Tera language</div>
            <h1>Documentation</h1>
            <p>Learn Tera from the ground up — syntax, types, models, DataFrames, and reactivity — then browse the full standard-library reference.</p>
          </div>

          {GUIDE_CHAPTERS.map((chapter) => (
            <section className="docs-chapter" id={chapter.id} key={chapter.id}>
              <h2 className="docs-chapter-title">{chapter.title}</h2>
              <DocBlocks blocks={chapter.blocks} />
            </section>
          ))}

          <section className="docs-chapter" id={REFERENCE_ID}>
            <h2 className="docs-chapter-title">Standard library reference</h2>
            <p className="docs-text">Every keyword, type, operator, builtin, and method — generated directly from the language spec.</p>
            <ReferenceView model={referenceModel} />
          </section>
        </main>
      </div>
    </div>
  );
}
