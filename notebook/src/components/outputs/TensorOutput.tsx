type TensorOutputProps = {
  tensor: {
    shape: number[];
    data: unknown;
    summary: string;
  };
};

function formatCell(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : Number(value.toPrecision(6)).toString();
  if (value === null) return "null";
  if (value === undefined) return "";
  return String(value);
}

function isMatrix(value: unknown): value is unknown[][] {
  return Array.isArray(value) && value.every((row) => Array.isArray(row));
}

function previewRows(rows: unknown[][]): unknown[][] {
  return rows.slice(0, 12).map((row) => row.slice(0, 12));
}

export function TensorOutput({ tensor }: TensorOutputProps) {
  const data = tensor.data;
  if (isMatrix(data)) {
    const rows = previewRows(data);
    const truncatedRows = data.length > rows.length;
    const truncatedCols = data.some((row) => Array.isArray(row) && row.length > 12);
    return (
      <div className="tensor-view">
        <div className="tensor-meta">{tensor.summary}</div>
        <div className="tensor-scroll">
          <table className="tensor-grid">
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, colIndex) => <td key={colIndex}>{formatCell(cell)}</td>)}
                  {truncatedCols && <td className="tensor-ellipsis">...</td>}
                </tr>
              ))}
              {truncatedRows && (
                <tr>
                  <td className="tensor-ellipsis" colSpan={(rows[0]?.length ?? 1) + (truncatedCols ? 1 : 0)}>...</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="tensor-view">
      <div className="tensor-meta">{tensor.summary}</div>
      <div className="tensor-value">{Array.isArray(data) ? JSON.stringify(data) : formatCell(data)}</div>
    </div>
  );
}
