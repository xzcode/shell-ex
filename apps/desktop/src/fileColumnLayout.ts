export const FILE_CHECK_COLUMN_WIDTH = 34;
export const FILE_COLUMN_MAX_WIDTH = 1400;

export function fileTableWidth(widths: readonly number[]): number {
  return FILE_CHECK_COLUMN_WIDTH + widths.reduce((sum, width) => sum + width, 0);
}

/** Preferred column widths are not changed by resizing the window.
 * Distribute spare space among existing columns, keeping the checkbox fixed.
 * If a manually resized column is locked, it retains the requested width.
 * Only allow horizontal scrolling when the preferred widths exceed the viewport.
 */
export function fitFileColumnWidths(
  preferred: readonly number[], viewportWidth: number, lockedIndex = -1,
): number[] {
  const widths = [...preferred];
  let extra = Math.max(0, Math.floor(viewportWidth) - fileTableWidth(widths));
  const unlocked = widths.map((_, i) => i).filter(i => i !== lockedIndex);
  let candidates = unlocked.filter(i => widths[i] < FILE_COLUMN_MAX_WIDTH);
  while (extra > 0 && candidates.length) {
    const share = Math.ceil(extra / candidates.length);
    for (const index of candidates) {
      const growth = Math.min(extra, share, FILE_COLUMN_MAX_WIDTH - widths[index]);
      widths[index] += growth;
      extra -= growth;
    }
    candidates = candidates.filter(i => widths[i] < FILE_COLUMN_MAX_WIDTH);
  }
  // On exceptionally wide displays, still fill the viewport after reaching
  // the normal persisted-width cap. This expansion is a display preference only.
  if (extra > 0 && unlocked.length) widths[unlocked[0]] += extra;
  return widths;
}

/** Use the currently rendered widths as the starting point for a user resize.
 * Growing one column leaves the others unchanged; shrinking redistributes
 * newly freed space to the other columns rather than exposing an empty strip.
 */
export function resizeFileColumnWidths(
  rendered: readonly number[], index: number, width: number, viewportWidth: number,
): number[] {
  return fitFileColumnWidths(
    rendered.map((value, i) => i === index ? width : value),
    viewportWidth, index,
  );
}
