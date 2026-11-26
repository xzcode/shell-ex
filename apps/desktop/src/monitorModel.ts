import { useEffect, useState } from "react";
import type { DiskIo, DiskMount, ProcessInfo } from "./types";

export type StorageFilter = "storage" | "local" | "network" | "all";
export type ProcessSortKey = "cpu" | "memory" | "pid" | "user" | "command";
export type ProcessSort = { key: ProcessSortKey; direction: "asc" | "desc" };
export function filterMounts(mounts: DiskMount[], filter: StorageFilter) {
  return mounts.filter((mount) => filter === "all" ||
    (!mount.duplicate && (filter === "storage"
      ? mount.category === "local" || mount.category === "network" : mount.category === filter)));
}
export function sortProcesses(processes: readonly ProcessInfo[], sort: ProcessSort, query = "") {
  const q = query.trim().toLocaleLowerCase();
  const rows = processes.filter((p) => !q || [String(p.pid), p.user, p.command].some((v) => v.toLocaleLowerCase().includes(q)));
  const order = sort.direction === "asc" ? 1 : -1;
  return rows.sort((a, b) => {
    const left = sort.key === "memory" ? a.rssBytes : a[sort.key];
    const right = sort.key === "memory" ? b.rssBytes : b[sort.key];
    // Unavailable first-interval CPU or RSS never sorts as zero.
    if (left == null) return right == null ? a.pid - b.pid : 1;
    if (right == null) return -1;
    const cmp = typeof left === "number" && typeof right === "number" ? left - right
      : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
    return order * cmp || a.pid - b.pid;
  });
}
export function diskKey(disk: DiskIo) { return disk.deviceId + "/" + disk.name; }
export type DiskHistory = Record<string, { at: number; read: number; write: number; busy: number }[]>;
export function appendDiskHistory(old: DiskHistory, disks: DiskIo[], at: number): DiskHistory {
  const next: DiskHistory = {};
  for (const disk of disks) {
    const key = diskKey(disk);
    if (disk.readBytesPerSec == null || disk.writeBytesPerSec == null || disk.utilization == null) {
      next[key] = [];
      continue;
    }
    next[key] = [...(old[key] || []).slice(-39), {
      at, read: disk.readBytesPerSec, write: disk.writeBytesPerSec, busy: disk.utilization,
    }];
  }
  return next;
}
export function useMonitorPreference<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const storageKey = "shell-ex-monitor-" + key;
  const read = () => {
    try {
      const value = localStorage.getItem(storageKey);
      if (allowed.includes(value as T)) return value as T;
    } catch { /* session fallback */ }
    return fallback;
  };
  const [value, setValue] = useState<T>(read);
  useEffect(() => {
    function update(e: StorageEvent) {
      if (e.key === storageKey) setValue(read());
    }
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [storageKey]);
  function save(next: T) {
    setValue(next);
    try { localStorage.setItem(storageKey, next); } catch { /* session fallback */ }
  }
  return [value, save] as const;
}
