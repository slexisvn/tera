import { useEffect, useState, type MutableRefObject } from "react";
import { DF_PAGE_SIZE } from "../../config/constants";
import { KernelClient } from "../../services/kernel-client";
import type { DataFrameRow, KernelValue } from "../../types/notebook";

type DataFrameOutputProps = {
  dataframe: Extract<KernelValue, { kind: "dataframe" }>;
  kernel: MutableRefObject<KernelClient | null>;
};

export function DataFrameOutput({ dataframe, kernel }: DataFrameOutputProps) {
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<DataFrameRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const to = Math.min(dataframe.total, offset + rows.length);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    kernel.current?.call<{ rows: DataFrameRow[] }>("dataframePage", { id: dataframe.id, offset, limit: DF_PAGE_SIZE })
      .then((result) => {
        if (!cancelled) setRows(result.rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataframe.id, kernel, offset]);

  if (error) return <div className="error">{error}</div>;
  return (
    <div className={`df-view${loading ? " df-loading" : ""}`}>
      <div className="df-scroll">
        <table className="df-grid">
          <thead>
            <tr>{dataframe.columns.map((column) => <th key={column}>{column}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {dataframe.columns.map((column) => {
                  const value = row[column];
                  return <td className={value == null ? "df-null" : undefined} key={column}>{value == null ? "NULL" : String(value)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="df-pager">
        <button type="button" disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - DF_PAGE_SIZE))}>Prev</button>
        <span className="df-info">{dataframe.total === 0 ? 0 : offset + 1}-{to} of {dataframe.total} · {dataframe.columns.length} cols</span>
        <button type="button" disabled={to >= dataframe.total} onClick={() => setOffset(offset + DF_PAGE_SIZE)}>Next</button>
      </div>
    </div>
  );
}
