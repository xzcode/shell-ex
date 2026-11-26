import { useEffect, useState, type ReactNode } from "react";
import { tr } from "./i18n";
import { ResizeHandle, clampWidth } from "./ResizeHandle";

type Column = { label: string; width: number; min: number };
type Props = {
  tableId: string;
  columns: readonly Column[];
  className?: string;
  children: ReactNode;
};

/** Shared column preferences for the docked and detached monitor.
 * Native WebViews with a shared origin synchronize via storage events.
 * Otherwise each view retains its own preferences safely. */
export function MonitorTable({ tableId, columns, className = "", children }: Props) {
  const storageKey = "shell-ex-monitor-columns-" + tableId;
  function decode(raw: string | null) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(raw || "null"); } catch { /* old preferences */ }
    return columns.map((column, i) =>
      clampWidth(Array.isArray(parsed) ? parsed[i] : undefined, column.width, column.min, 1400));
  }
  const [widths, setWidths] = useState(() => {
    try { return decode(localStorage.getItem(storageKey)); }
    catch { return columns.map((column) => column.width); }
  });
  useEffect(() => {
    function refresh(event: StorageEvent) {
      if (event.key === storageKey) setWidths(decode(event.newValue));
    }
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
    // The column schema is constant for each keyed table instance.
  }, [storageKey]);
  function change(index: number, width: number) {
    const next = widths.map((value, i) => i === index ? width : value);
    setWidths(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* session-only fallback */ }
  }
  return <table className={"resizable-monitor-table " + className}
    data-monitor-table={tableId}
    style={{ minWidth: widths.reduce((sum, width) => sum + width, 0) }}>
    <colgroup>
      {widths.map((width, i) => <col key={i} style={{ width }} />)}
      <col />
    </colgroup>
    <thead><tr>
      {columns.map((column, index) => <th key={index} className="resizable-monitor-heading" title={tr(column.label)}>
        <div className="file-heading-content">
          <span>{tr(column.label)}</span>
          <ResizeHandle column label={tr("调整列宽：{0}", tr(column.label))}
            value={widths[index]} min={column.min} max={1400}
            onChange={(width) => change(index, width)}
            onReset={() => change(index, column.width)} />
        </div>
      </th>)}
      <th className="monitor-table-filler" aria-hidden="true" />
    </tr></thead>
    <tbody>{children}</tbody>
  </table>;
}
