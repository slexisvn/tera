export function DataTable({ columns, rows, caption }: { columns: string[]; rows: string[][]; caption?: string }) {
  return <div className="table-scroll"><table className="data-table">
    {caption && <caption>{caption}</caption>}
    <thead><tr><th scope="col" aria-label="Row">#</th>{columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={row.join('-')}><th scope="row">{index}</th>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
  </table></div>;
}
