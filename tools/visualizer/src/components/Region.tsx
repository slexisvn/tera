import type { ReactNode } from "react";
import type { RegionId } from "../config/panes";

type RegionProps = {
  id: RegionId;
  hidden: boolean;
  children: ReactNode;
};

export function Region({ id, hidden, children }: RegionProps) {
  return (
    <div className="region" data-region={id} data-hidden={hidden || undefined}>
      {children}
    </div>
  );
}
