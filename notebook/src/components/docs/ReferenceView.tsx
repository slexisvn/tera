import { useMemo, useState } from "react";
import {
  filterReferenceModel,
  type ChipSection,
  type Entry,
  type EntrySection,
  type MemberGroup,
  type ReferenceModel,
} from "@/docs/reference";
import { renderInline } from "./inline";

type ReferenceViewProps = {
  model: ReferenceModel;
};

function EntryCard({ entry }: { entry: Entry }) {
  const showReturn = entry.returns && !entry.signature.includes("->");
  return (
    <article className="ref-item">
      <div className="ref-item-head">
        <code className="ref-item-sig">{entry.signature}</code>
        <span className="ref-item-tags">
          {showReturn ? <span className="ref-tag ref-tag-type">{entry.returns}</span> : null}
          {entry.effect !== "sync" ? <span className="ref-tag ref-tag-effect">{entry.effect}</span> : null}
        </span>
      </div>
      {entry.description ? <p className="ref-item-desc">{renderInline(entry.description)}</p> : null}
    </article>
  );
}

function ChipSectionView({ section }: { section: ChipSection }) {
  return (
    <section className="ref-section" id={section.id}>
      <h3 className="ref-section-title">{section.title}</h3>
      {section.rows.map((row) => (
        <div className="ref-chip-row" key={row.label || section.id}>
          {row.label ? <span className="ref-chip-label">{row.label}</span> : null}
          <div className="ref-chips">
            {row.items.map((item) => <code className="ref-chip" key={item}>{item}</code>)}
          </div>
        </div>
      ))}
    </section>
  );
}

function EntrySectionView({ section }: { section: EntrySection }) {
  return (
    <section className="ref-section" id={section.id}>
      <h3 className="ref-section-title">{section.title}</h3>
      <div className="ref-items">
        {section.entries.map((entry) => <EntryCard key={entry.key} entry={entry} />)}
      </div>
    </section>
  );
}

function MemberGroupView({ group }: { group: MemberGroup }) {
  return (
    <section className="ref-section" id={group.id}>
      <h3 className="ref-section-title"><code>{group.name}</code></h3>
      <div className="ref-items">
        {group.entries.map((entry) => <EntryCard key={entry.key} entry={entry} />)}
      </div>
    </section>
  );
}

export function ReferenceView({ model }: ReferenceViewProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterReferenceModel(model, query.trim().toLowerCase()), [model, query]);
  const empty = !filtered.chipSections.length && !filtered.categories.length && !filtered.members.length;

  return (
    <div className="ref-view">
      <input
        className="ref-search"
        type="search"
        placeholder="Search tensor, model, DataFrame..."
        autoComplete="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {empty ? (
        <div className="ref-empty">No matching reference entries.</div>
      ) : (
        <>
          {filtered.chipSections.map((section) => <ChipSectionView key={section.id} section={section} />)}
          {filtered.categories.map((section) => <EntrySectionView key={section.id} section={section} />)}
          {filtered.members.map((group) => <MemberGroupView key={group.id} group={group} />)}
        </>
      )}
    </div>
  );
}
