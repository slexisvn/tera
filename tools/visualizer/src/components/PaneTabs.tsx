import { useEffect, useRef } from "react";
import { wordingOf, type PaneTab, type TabId } from "../config/panes";
import type { PipelineId } from "../types/stage";
import { Badge, type Badges } from "./Badge";

type PaneTabsProps = {
  tabs: readonly PaneTab[];
  active: TabId | null;
  pipeline: PipelineId;
  badges: Badges;
  onPick: (tab: PaneTab) => void;
};

export function PaneTabs({ tabs, active, pipeline, badges, onPick }: PaneTabsProps) {
  const current = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    current.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <nav className="pane-tabs" data-region="tabs" aria-label="Pane">
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab.id}
          ref={tab.id === active ? current : undefined}
          data-tab={tab.id}
          title={wordingOf(tab.title, pipeline)}
          aria-pressed={tab.id === active}
          onClick={() => onPick(tab)}
        >
          {wordingOf(tab.label, pipeline)}
          <Badge badge={badges[tab.id]} />
        </button>
      ))}
    </nav>
  );
}
