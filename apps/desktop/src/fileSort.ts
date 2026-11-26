import type { FileEntry } from "./types";

export const fileSortColumns = [
  { key: "name", label: "文件名" },
  { key: "size", label: "大小" },
  { key: "type", label: "类型" },
  { key: "modified", label: "修改时间" },
  { key: "permissions", label: "权限" },
  { key: "owner", label: "用户/用户组" },
] as const;
export type FileSortKey = (typeof fileSortColumns)[number]["key"];
export type FileSort = { column: FileSortKey; direction: "asc" | "desc" };
export const defaultFileSort: FileSort = { column: "name", direction: "asc" };
export const FILE_SORT_STORAGE_KEY = "shell-ex-file-sort-v1";

export function parseFileSort(raw: string | null): FileSort {
  try {
    const value: unknown = JSON.parse(raw || "null");
    if (value && typeof value === "object" && "column" in value && "direction" in value
      && fileSortColumns.some(({ key }) => key === value.column)
      && (value.direction === "asc" || value.direction === "desc")) {
      return { column: value.column as FileSortKey, direction: value.direction };
    }
  } catch { /* A corrupt or old preference must not prevent browsing. */ }
  return { ...defaultFileSort };
}

export function nextFileSort(previous: FileSort, column: FileSortKey): FileSort {
  return { column, direction: previous.column === column && previous.direction === "asc" ? "desc" : "asc" };
}

// Sort the metadata already returned by SFTP, never the formatted cell text.
export function sortFileEntries(entries: readonly FileEntry[], sort: FileSort, locale: string): FileEntry[] {
  const names = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const direction = sort.direction === "asc" ? 1 : -1;
  const known = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
  const numeric = (a: number | null | undefined, b: number | null | undefined) => {
    // Unknown values always remain last, regardless of sort direction.
    if (!known(a)) return known(b) ? 1 : 0;
    if (!known(b)) return -1;
    return direction * (a - b);
  };
  const nameOrder = (a: FileEntry, b: FileEntry) => names.compare(a.name, b.name)
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  // The order is consistent with the three kinds displayed in the type column.
  const kind = (entry: FileEntry) => entry.isSymlink ? 2 : entry.isDir ? 0 : 1;
  return [...entries].sort((a, b) => {
    let order = 0;
    switch (sort.column) {
      case "name":
        // Preserve the original default: directories before files.
        return Number(b.isDir) - Number(a.isDir) || direction * nameOrder(a, b);
      case "size":
        // A directory's own inode size is not the size of its contents.
        order = numeric(a.isDir ? null : a.size, b.isDir ? null : b.size);
        break;
      case "type":
        order = direction * (kind(a) - kind(b));
        break;
      case "modified":
        order = numeric(a.modified, b.modified);
        break;
      case "permissions":
        order = numeric(known(a.permissions) ? a.permissions & 0o7777 : null,
          known(b.permissions) ? b.permissions & 0o7777 : null);
        break;
      case "owner": {
        const aKnown = known(a.uid) && known(a.gid);
        const bKnown = known(b.uid) && known(b.gid);
        if (!aKnown || !bKnown) order = Number(bKnown) - Number(aKnown);
        else order = numeric(a.uid, b.uid) || numeric(a.gid, b.gid);
        break;
      }
    }
    return order || nameOrder(a, b);
  });
}
