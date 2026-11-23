import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, AlertCircle } from "lucide-react";
import type { FileEntry } from "./types";
import { api, errorText } from "./api";

/** Lazy SFTP folder tree. Only directories that are expanded or in the active path are queried. */
export function DirectoryTree({
  sessionId, currentPath, onNavigate,
}: { sessionId: string; currentPath: string; onNavigate: (path: string) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["/"]));
  const [nodes, setNodes] = useState<Record<string, FileEntry[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const loaded = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadDir = useCallback(async (dir: string) => {
    if (loaded.current.has(dir) || pending.current.has(dir)) return;
    pending.current.add(dir);
    try {
      const items = await api<FileEntry[]>("sftp_list", { sessionId, path: dir });
      if (!mounted.current) return;
      setNodes((old) => ({ ...old, [dir]: items.filter((item) => item.isDir && !item.isSymlink).slice(0, 200) }));
      loaded.current.add(dir);
      setErrors((old) => {
        if (!(dir in old)) return old;
        const copy = { ...old }; delete copy[dir]; return copy;
      });
    } catch (e) {
      if (mounted.current) setErrors((old) => ({ ...old, [dir]: errorText(e) }));
    } finally {
      pending.current.delete(dir);
    }
  }, [sessionId]);

  useEffect(() => {
    // "dot" means the remote home directory before canonicalization.
    if (!currentPath.startsWith("/")) return;
    const parts = currentPath.split("/").filter(Boolean);
    const dirs = ["/"];
    let prefix = "";
    for (const part of parts) {
      prefix += "/" + part;
      dirs.push(prefix);
    }
    setExpanded((old) => new Set([...old, ...dirs]));
    for (const dir of dirs) void loadDir(dir);
  }, [currentPath, loadDir]);

  function toggle(dir: string) {
    if (expanded.has(dir)) {
      setExpanded((old) => { const next = new Set(old); next.delete(dir); return next; });
    } else {
      setExpanded((old) => new Set([...old, dir]));
      void loadDir(dir);
    }
  }

  function renderChildren(parent: string, depth: number): React.ReactNode {
    if (!expanded.has(parent) || depth > 20) return null;
    const children = nodes[parent];
    if (!children) return errors[parent] ? (
      <div className="folder-tree-error" title={errors[parent]}>
        <AlertCircle size={12} /> 无法读取此目录
        <button onClick={() => { delete errors[parent]; void loadDir(parent); }}>重试</button>
      </div>
    ) : <div className="folder-tree-loading">读取中…</div>;
    return children.map((item) => (
      <div key={item.path}>
        <div className={`folder-tree-row${item.path === currentPath ? " selected" : ""}`}
          style={{ paddingLeft: 10 + depth * 13 }}
          onClick={() => onNavigate(item.path)}
          title={item.path}
          role="treeitem"
          aria-selected={item.path === currentPath}
          aria-expanded={expanded.has(item.path)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter") onNavigate(item.path);
            if (e.key === "ArrowRight") { e.preventDefault(); toggle(item.path); }
            if (e.key === "ArrowLeft" && expanded.has(item.path)) { e.preventDefault(); toggle(item.path); }
          }}
        >
          <button aria-label={expanded.has(item.path) ? `收起 ${item.name}` : `展开 ${item.name}`}
            onClick={(e) => { e.stopPropagation(); toggle(item.path); }}>
            {expanded.has(item.path) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          <Folder size={14} className="folder-icon" />
          <span>{item.name}</span>
        </div>
        {renderChildren(item.path, depth + 1)}
      </div>
    ));
  }

  return (
    <aside className="directory-tree scroll-area" aria-label="远程目录树">
      <div className={`folder-tree-row${currentPath === "/" ? " selected" : ""}`}
        role="treeitem" aria-expanded={expanded.has("/")} aria-selected={currentPath === "/"} tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") onNavigate("/"); }}
        onClick={() => onNavigate("/")}>
        <button aria-label={expanded.has("/") ? "收起根目录" : "展开根目录"}
          onClick={(e) => { e.stopPropagation(); toggle("/"); }}>
          {expanded.has("/") ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <Folder size={14} className="folder-icon" /> <span>/</span>
      </div>
      {renderChildren("/", 1)}
    </aside>
  );
}
