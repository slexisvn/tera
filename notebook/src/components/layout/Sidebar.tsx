import type { UploadedFileMeta } from "../../types/notebook";
import { fmtSize, loadCommandFor } from "../../utils/file-utils";

type SidebarProps = {
  files: Map<string, UploadedFileMeta>;
  onInsert: (name: string) => void;
  onRemove: (name: string) => void;
};

export function Sidebar({ files, onInsert, onRemove }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">Files</div>
      <ul className="files-list">
        {[...files.entries()].map(([name, meta]) => (
          <li className="file-item" key={name}>
            <button className="file-open" title={`Insert: ${loadCommandFor(name)}`} type="button" onClick={() => onInsert(name)}>
              <span className="file-name">{name}</span>
              <span className="file-meta">{meta.kind === "csv" ? `${meta.rowCount} rows · ${fmtSize(meta.size)}` : `${(meta.ext || "file").toUpperCase()} · ${fmtSize(meta.size)}`}</span>
            </button>
            <button className="file-del" title="Remove file" type="button" onClick={() => onRemove(name)}>x</button>
          </li>
        ))}
      </ul>
      {!files.size && (
        <div className="files-empty">No files yet. Click <b>File</b> or drag and drop files here, then click a file to insert its load command.</div>
      )}
    </aside>
  );
}
