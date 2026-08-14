import { useEffect } from "react";
import { DocBlocks } from "../components/docs/DocBlocks";
import { GUIDE_CHAPTERS } from "../docs/guide-content";
import { navigateTo, useHashRoute } from "../utils/hash-route";
import { useTheme } from "../utils/use-theme";

function activeIndex(route: string): number {
  const slug = route.replace(/^\/docs\/?/, "");
  if (!slug) return 0;
  const index = GUIDE_CHAPTERS.findIndex((chapter) => chapter.id === slug);
  return index >= 0 ? index : 0;
}

const NAV_GROUPS = GUIDE_CHAPTERS.reduce<string[]>((groups, chapter) => {
  if (!groups.includes(chapter.group)) groups.push(chapter.group);
  return groups;
}, []);

export function DocsPage() {
  const [theme, toggleTheme] = useTheme();
  const route = useHashRoute();
  const index = activeIndex(route);
  const chapter = GUIDE_CHAPTERS[index];
  const prev = GUIDE_CHAPTERS[index - 1];
  const next = GUIDE_CHAPTERS[index + 1];

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [chapter.id]);

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
          {NAV_GROUPS.map((group) => (
            <div className="docs-nav-group" key={group}>
              <div className="docs-nav-title">{group}</div>
              {GUIDE_CHAPTERS.filter((item) => item.group === group).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`docs-nav-link${item.id === chapter.id ? " active" : ""}`}
                  onClick={() => navigateTo(`/docs/${item.id}`)}
                >
                  <span className="docs-nav-label">{item.title}</span>
                  {item.wip ? <span className="docs-nav-badge">soon</span> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <main className="docs-main">
          <article className="docs-chapter" key={chapter.id}>
            <div className="docs-chapter-eyebrow">{chapter.group}</div>
            <h1 className="docs-chapter-heading">{chapter.title}</h1>
            <p className="docs-chapter-lede">{chapter.summary}</p>
            {chapter.wip ? (
              <div className="docs-wip">
                <span className="docs-wip-tag">Work in progress</span>
                <p>This section is being written. The core language sections are ready — check back soon for this one.</p>
              </div>
            ) : (
              <DocBlocks blocks={chapter.blocks} />
            )}
          </article>

          <nav className="docs-pager" aria-label="Chapter navigation">
            {prev ? (
              <button type="button" className="docs-pager-link prev" onClick={() => navigateTo(`/docs/${prev.id}`)}>
                <span className="docs-pager-dir">← Previous</span>
                <span className="docs-pager-title">{prev.title}</span>
              </button>
            ) : <span className="docs-pager-spacer" />}
            {next ? (
              <button type="button" className="docs-pager-link next" onClick={() => navigateTo(`/docs/${next.id}`)}>
                <span className="docs-pager-dir">Next →</span>
                <span className="docs-pager-title">{next.title}</span>
              </button>
            ) : <span className="docs-pager-spacer" />}
          </nav>
        </main>
      </div>
    </div>
  );
}
