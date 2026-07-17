import { useEffect, useRef } from "react";
import { renderNotebookChart } from "../../services/chart-runtime";
import type { ChartSpec } from "../../types/notebook";

export function ChartOutput({ spec }: { spec: ChartSpec }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    let cleanup: void | (() => void);
    let cancelled = false;
    renderNotebookChart(ref.current, spec).then((result) => {
      if (cancelled && typeof result === "function") result();
      else cleanup = result;
    });
    return () => {
      cancelled = true;
      if (typeof cleanup === "function") cleanup();
    };
  }, [spec]);

  return <div className="chart-view" ref={ref} />;
}
