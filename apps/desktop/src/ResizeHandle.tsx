import { useEffect, useRef, useState, type MouseEvent } from "react";

export function clampWidth(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.round(Math.max(min, Math.min(max, n)));
}

/** Desktop mouse resizing uses window listeners instead of depending on
 * pointer capture on a positioned table cell (which can differ in WebKit).
 * The separator also supports keyboard changes and double-click reset. */
export function ResizeHandle({
  label, value, min, max, direction = 1, measured, onChange, onReset, column = false,
}: {
  label: string; value: number; min: number; max: number;
  direction?: 1 | -1; measured?: () => number;
  onChange: (width: number) => void; onReset?: () => void; column?: boolean;
}) {
  const cleanup = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => cleanup.current?.(), []);
  function start(e: MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    cleanup.current?.();
    const x = e.clientX;
    const width = measured?.() ?? value;
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.body.classList.add("shell-resizing");
    setDragging(true);
    function move(event: globalThis.MouseEvent) {
      if (event.buttons === 0) { end(); return; }
      event.preventDefault();
      onChange(clampWidth(width + direction * (event.clientX - x), value, min, max));
    }
    function end() {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", end, true);
      window.removeEventListener("blur", end);
      document.body.style.cursor = previousCursor;
      document.body.classList.remove("shell-resizing");
      cleanup.current = null;
      setDragging(false);
    }
    cleanup.current = end;
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", end, true);
    window.addEventListener("blur", end);
  }
  return <div
    className={(column ? "column-resize-handle" : "resize-handle vertical wide-hit") + (dragging ? " resizing" : "")}
    role="separator" aria-orientation="vertical" aria-label={label}
    aria-valuemin={min} aria-valuemax={max}
    aria-valuenow={clampWidth(value, min, min, max)}
    title={label} tabIndex={0}
    onMouseDown={start}
    onClick={(e) => e.stopPropagation()}
    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); onReset?.(); }}
    onKeyDown={(e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const current = measured?.() ?? value;
      const next = e.key === "Home" ? min : e.key === "End" ? max
        : current + direction * (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 32 : 8);
      onChange(clampWidth(next, value, min, max));
    }}
  />;
}
