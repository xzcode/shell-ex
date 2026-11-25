import { useRef, type PointerEvent } from "react";

export function clampWidth(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.round(Math.max(min, Math.min(max, n)));
}

/** Pointer capture keeps resizing reliable even when crossing a table or terminal. */
export function ResizeHandle({
  label, value, min, max, direction = 1, measured, onChange, onReset, column = false,
}: {
  label: string; value: number; min: number; max: number;
  direction?: 1 | -1; measured?: () => number;
  onChange: (width: number) => void; onReset?: () => void; column?: boolean;
}) {
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  function start(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { pointer: e.pointerId, x: e.clientX, width: measured?.() ?? value };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function stop(e: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointer !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  }
  return <div
    className={column ? "column-resize-handle" : "resize-handle vertical wide-hit"}
    role="separator" aria-orientation="vertical" aria-label={label}
    aria-valuemin={min} aria-valuemax={max}
    aria-valuenow={clampWidth(value, min, min, max)}
    title={label} tabIndex={0}
    onPointerDown={start}
    onPointerMove={(e) => {
      const d = drag.current;
      if (d?.pointer === e.pointerId)
        onChange(clampWidth(d.width + direction * (e.clientX - d.x), value, min, max));
    }}
    onPointerUp={stop} onPointerCancel={stop}
    onLostPointerCapture={() => { drag.current = null; }}
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
