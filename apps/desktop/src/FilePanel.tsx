import { tr, getLocale } from "./i18n";
import { createPortal } from "react-dom";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Folder,
  FileCode2,
  File,
  ArrowUp,
  RefreshCw,
  Upload,
  Download,
  FolderPlus,
  FolderUp,
  Pencil,
  Trash2,
  Shield,
  Home,
  ChevronRight,
  Link2,
} from "lucide-react";
import type { FileEntry, Notify, Session } from "./types";
import {
  api,
  bytes,
  chooseFile,
  confirmAction,
  errorText,
  joinPath,
  native,
  parentPath,
  savePath,
} from "./api";
import { Busy, Empty, ErrorBox, Field, IconButton, Modal } from "./ui";
import { DirectoryTree } from "./DirectoryTree";
import { ResizeHandle } from "./ResizeHandle";
import { defaultWorkspace } from "./types";
const EditorDialog = lazy(() => import("./RemoteEditor"));
function permissionText(entry: FileEntry): string {
  if (entry.permissions == null) return "—";
  const mode = entry.permissions;
  const flags = [0o400,0o200,0o100,0o040,0o020,0o010,0o004,0o002,0o001];
  const chars = ["r","w","x","r","w","x","r","w","x"];
  let suffix = flags.map((flag,i) => mode & flag ? chars[i] : "-");
  if (mode & 0o4000) suffix[2] = mode & 0o100 ? "s" : "S";
  if (mode & 0o2000) suffix[5] = mode & 0o010 ? "s" : "S";
  if (mode & 0o1000) suffix[8] = mode & 0o001 ? "t" : "T";
  return (entry.isSymlink ? "l" : entry.isDir ? "d" : "-") + suffix.join("");
}
export function FilePanel({
  session,
  notify,
  onTransfer,
  treeWidth,
  columnWidths,
  onTreeWidth,
  onColumnWidth,
}: {
  session: Session | null;
  notify: Notify;
  onTransfer: () => void;
  treeWidth: number;
  columnWidths: number[];
  onTreeWidth: (width: number) => void;
  onColumnWidth: (index: number, width: number) => void;
}) {
  const [path, setPath] = useState(".");
  const [inputPath, setInputPath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [plainEditor, setPlainEditor] = useState(false);
  const [defaultPlainEditor, setDefaultPlainEditor] = useState(() => {
    try { return localStorage.getItem("shell-ex-default-text-editor") === "plain"; }
    catch { return false; }
  });
  const [menu, setMenu] = useState<{ x: number; y: number; targets: FileEntry[]; section: "open" | "editor" | "new" | null } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [operation, setOperation] = useState<{
    kind: "mkdir" | "touch" | "rename" | "chmod";
    entry?: FileEntry;
  } | null>(null);
  const [value, setValue] = useState("");
  const [working, setWorking] = useState(false);
  const [showHidden, setShowHidden] = useState(true);
  const [filter, setFilter] = useState("");
  const [directoryPlan, setDirectoryPlan] = useState<{
    id: string;
    totalFiles: number;
    totalBytes: number;
    existingFiles: number;
    skippedLinks: string[];
    localRoot: string;
    remoteRoot: string;
    direction: "upload" | "download";
  } | null>(null);
  const [conflict, setConflict] = useState<"skip" | "overwrite">("skip");
  const request = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  const explorerRef = useRef<HTMLDivElement>(null);
  const [explorerWidth, setExplorerWidth] = useState(800);
  useEffect(() => {
    if (!explorerRef.current) return;
    const target = explorerRef.current;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setExplorerWidth(entry.contentRect.width);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [session?.id, session?.status, session?.local]);
  const sessionIdentity = useRef(session?.id);
  sessionIdentity.current = session?.id;
  const remote =
    session && !session.local && session.status === "connected"
      ? session
      : null;
  const load = useCallback(async () => {
    if (!remote) return;
    const serial = ++request.current;
    setLoading(true);
    setError("");
    try {
      const canonical = await api<string>("sftp_realpath", { sessionId: remote.id, path });
      if (serial !== request.current) return;
      if (canonical !== path) {
        setPath(canonical);
        setInputPath(canonical);
        return;
      }
      const list = await api<FileEntry[]>("sftp_list", {
        sessionId: remote.id,
        path,
      });
      if (serial !== request.current) return;
      setEntries(
        list.sort(
          (a, b) =>
            Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name),
        ),
      );
      setSelected(new Set());
    } catch (e) {
      if (serial === request.current) setError(errorText(e));
    } finally {
      if (serial === request.current) setLoading(false);
    }
  }, [remote?.id, path]);
  useEffect(() => {
    setPath(".");
    setInputPath(".");
    setEntries([]);
    setSelected(new Set());
    setEditing(null);
    setMenu(null);
    setDirectoryPlan(null);
    setOperation(null);
    request.current++;
  }, [session?.id]);
  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [load]);
  function navigate(next: string) {
    setMenu(null);
    setPath(next || ".");
    setInputPath(next || ".");
  }
  useEffect(() => {
    setMenu(null);
  }, [path, loading, working]);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", escapeMenu);
    function escapeMenu() { setMenu(null); }
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", escapeMenu);
    };
  }, [!!menu]);
  function openEntry(entry: FileEntry, plain = defaultPlainEditor) {
    if (entry.isDir) navigate(entry.path);
    else {
      setPlainEditor(plain);
      setEditing(entry.path);
    }
  }
  function chooseDefaultEditor(plain: boolean) {
    setDefaultPlainEditor(plain);
    try { localStorage.setItem("shell-ex-default-text-editor", plain ? "plain" : "code"); }
    catch { /* Preference remains available for this session. */ }
  }
  function openContext(x: number, y: number, entry?: FileEntry) {
    if (working || loading) return;
    const targets = entry
      ? selected.has(entry.path) ? entries.filter((item) => selected.has(item.path)) : [entry]
      : [];
    setSelected(new Set(targets.map((item) => item.path)));
    setMenu({ x, y, targets, section: null });
  }
  async function copyPaths(targets: FileEntry[]) {
    try {
      await navigator.clipboard.writeText(targets.length ? targets.map((item) => item.path).join("\n") : path);
      notify(tr("路径已复制。"), "success");
    } catch (e) {
      notify(errorText(e), "error");
    }
  }
  async function upload(paths?: string[]) {
    if (!remote) return;
    try {
      const result = paths || (await chooseFile({ multiple: true }));
      if (!result) return;
      for (const localPath of typeof result === "string" ? [result] : result) {
        const name = localPath.split(/[\\/]/).pop()!;
        const exists = entries.some((f) => f.name === name);
        if (
          exists &&
          !(await confirmAction(
            tr("远程文件 {0} 已存在。是否覆盖？", joinPath(path, name)),
            tr("覆盖远程文件"),
          ))
        )
          continue;
        await api("transfer_start", {
          sessionId: remote.id,
          direction: "upload",
          localPath,
          remotePath: joinPath(path, name),
          overwrite: exists,
        });
      }
      notify(tr("文件已加入传输队列。"), "success");
      onTransfer();
    } catch (e) {
      notify(errorText(e), "error");
    }
  }
  useEffect(() => {
    if (!native || !remote) return;
    let stop: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            const rect = panel.current?.getBoundingClientRect();
            const p = event.payload.position;
            const scale = window.devicePixelRatio;
            if (
              rect &&
              p.x / scale >= rect.left &&
              p.x / scale <= rect.right &&
              p.y / scale >= rect.top &&
              p.y / scale <= rect.bottom
            )
              void upload(event.payload.paths);
          }
        }),
      )
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, [remote?.id, path, entries]);
  async function planDirectory(
    direction: "upload" | "download",
    entry?: FileEntry,
  ) {
    if (!remote) return;
    setWorking(true);
    try {
      const selected = await chooseFile({ directory: true });
      if (typeof selected !== "string") return;
      const rootName = (direction === "upload" ? selected : entry!.path)
        .replace(/[\\/]$/, "")
        .split(/[\\/]/)
        .pop()!;
      const plan = await api<{
        id: string;
        totalFiles: number;
        totalBytes: number;
        existingFiles: number;
        skippedLinks: string[];
        localRoot: string;
        remoteRoot: string;
      }>("transfer_plan_directory", {
        sessionId: remote.id,
        direction,
        localRoot:
          direction === "upload" ? selected : joinPath(selected, rootName),
        remoteRoot:
          direction === "upload" ? joinPath(path, rootName) : entry!.path,
      });
      if (sessionIdentity.current !== remote.id) return;
      setConflict("skip");
      setDirectoryPlan({ ...plan, direction });
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setWorking(false);
    }
  }
  async function startDirectory() {
    if (!directoryPlan) return;
    setWorking(true);
    try {
      const result = await api<{
        queued: number;
        skipped: number;
        transferIds: string[];
        errors: string[];
      }>("transfer_start_directory", { planId: directoryPlan.id, conflict });
      setDirectoryPlan(null);
      notify(
        tr("已加入 {0} 项传输，跳过 {1} 项。", result.queued, result.skipped),
        result.errors.length ? "info" : "success",
      );
      if (result.errors.length)
        notify(result.errors.map(errorText).join("；"), "error");
      onTransfer();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setWorking(false);
    }
  }
  async function chooseDownloadPath(name: string): Promise<string | null> {
    for (;;) {
      const destination = await savePath(name);
      if (!destination) return null;
      if (!(await api<boolean>("download_destination_exists", { path: destination })))
        return destination;
      if (!(await confirmAction(
        tr("本地文件已存在：{0}。原文件不会被覆盖，是否选择其他保存位置？", destination),
        tr("选择其他保存位置"),
      ))) return null;
    }
  }
  async function download(entry: FileEntry) {
    if (!remote) return;
    if (entry.isDir) {
      await planDirectory("download", entry);
      return;
    }
    try {
      const destination = await chooseDownloadPath(entry.name);
      if (!destination || sessionIdentity.current !== remote.id) return;
      await api("transfer_start", {
        sessionId: remote.id,
        direction: "download",
        localPath: destination,
        remotePath: entry.path,
        overwrite: false,
      });
      notify(tr("下载已加入传输队列。"), "success");
      onTransfer();
    } catch (e) {
      notify(errorText(e), "error");
    }
  }
  async function archiveDownload(targets: FileEntry[]) {
    if (!remote || !targets.length) return;
    setWorking(true);
    try {
      const name = targets.length === 1 ? targets[0].name + ".tar.gz" : "shell-ex-archive.tar.gz";
      const destination = await chooseDownloadPath(name);
      if (!destination || sessionIdentity.current !== remote.id) return;
      notify(tr("正在服务器上生成临时压缩包…"), "info");
      await api("transfer_start_archive", {
        sessionId: remote.id,
        paths: targets.map((item) => item.path),
        localPath: destination,
      });
      notify(tr("压缩包已加入下载队列。"), "success");
      onTransfer();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setWorking(false);
    }
  }
  async function recursiveRemove(entry: FileEntry) {
    if (!remote || !entry.isDir || entry.isSymlink) return;
    if (!(await confirmAction(
      tr("将永久递归删除目录及其所有内容：\n{0}\n\n此操作无法撤销。程序不会跟随符号链接。", entry.path),
      tr("确认递归删除"),
    ))) return;
    if (sessionIdentity.current !== remote.id) return;
    setWorking(true);
    try {
      await api("sftp_remove_tree", { sessionId: remote.id, path: entry.path });
      notify(tr("已删除选中的项目。"), "success");
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setWorking(false);
      await load();
    }
  }
  async function remove(targets = entries.filter((f) => selected.has(f.path))) {
    if (!remote || !targets.length) return;
    if (
      !(await confirmAction(
        tr("将删除 {0} 项：\n{1}\n\n删除无法撤销。非空目录不会递归删除。", targets.length, targets.map((f) => f.path).join("\n")),
        tr("删除远程文件"),
      ))
    )
      return;
    if (sessionIdentity.current !== remote.id) return;
    setWorking(true);
    try {
      for (const f of targets)
        await api("sftp_remove", {
          sessionId: remote.id,
          path: f.path,
          isDir: f.isDir,
        });
      notify(tr("已删除选中的项目。"), "success");
      await load();
    } catch (e) {
      notify(errorText(e), "error");
      await load();
    } finally {
      setWorking(false);
    }
  }
  async function applyOperation() {
    if (!remote || !operation) return;
    setWorking(true);
    try {
      if (operation.kind === "mkdir" || operation.kind === "touch") {
        if (!value || value.includes("/") || value.includes("\0") || value === "." || value === "..")
          throw new Error(tr("请输入单个文件名。"));
        await api(operation.kind === "mkdir" ? "sftp_mkdir" : "sftp_create_file", {
          sessionId: remote.id,
          path: joinPath(path, value),
        });
      } else if (operation.kind === "rename") {
        if (!value || value.includes("/") || value === "." || value === "..")
          throw new Error(tr("请输入单个文件名。"));
        await api("sftp_rename", {
          sessionId: remote.id,
          from: operation.entry!.path,
          to: joinPath(parentPath(operation.entry!.path), value),
        });
      } else {
        if (!/^[0-7]{3,4}$/.test(value))
          throw new Error(tr("权限应为三到四位八进制，例如 644、755。"));
        await api("sftp_chmod", {
          sessionId: remote.id,
          path: operation.entry!.path,
          mode: parseInt(value, 8),
        });
      }
      setOperation(null);
      await load();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setWorking(false);
    }
  }
  if (!remote)
    return (
      <Empty
        icon={<Folder size={25} />}
        title={session?.local ? tr("本地终端已打开") : tr("远程文件")}
        text={
          session?.local
            ? tr("连接 SSH 服务器后，在这里管理远程文件。")
            : tr("连接服务器后，安全浏览、传输和编辑文件。")
        }
      />
    );
  const filtered = entries.filter(
    (e) =>
      (showHidden || !e.name.startsWith(".")) &&
      e.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const chosen = entries.filter((e) => selected.has(e.path));
  const columnLabels = ["文件名", "大小", "类型", "修改时间", "权限", "用户/用户组"];
  const columnMin = [120, 64, 64, 112, 90, 78];
  const maxTreeWidth = Math.max(120, Math.min(700, explorerWidth - 200));
  const menuTargets = menu?.targets || [];
  const single = menuTargets.length === 1 ? menuTargets[0] : undefined;
  const canOpen = !!single;
  const canEdit = !!single && !single.isDir;
  const canPack = menuTargets.length > 0 && menuTargets.every((entry) => !entry.isSymlink);
  function runMenu(action: () => void) {
    setMenu(null);
    action();
  }
  function showOperation(kind: "mkdir" | "touch" | "rename" | "chmod", entry?: FileEntry) {
    setOperation({ kind, entry });
    setValue(kind === "rename" ? entry!.name : kind === "chmod" ? ((entry!.permissions || 0) & 0o7777).toString(8) : "");
  }
  return (
    <div className="file-panel" ref={panel}>
      <div className="panel-toolbar">
        <IconButton title={tr("上一级")} onClick={() => navigate(parentPath(path))}>
          <ArrowUp size={15} />
        </IconButton>
        <IconButton title={tr("用户主目录")} onClick={() => navigate(".")}>
          <Home size={15} />
        </IconButton>
        <form
          className="path-form"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(inputPath);
          }}
        >
          <Folder size={14} />
          <input
            aria-label={tr("远程目录")}
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
          />
          <button title={tr("打开目录")}>
            <ChevronRight size={14} />
          </button>
        </form>
        <IconButton
          title={tr("刷新文件列表")}
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? "spin" : ""} />
        </IconButton>
        <span className="toolbar-separator" />
        <button className="button subtle small" onClick={() => void upload()}>
          <Upload size={14} />{tr("上传")}</button>
        <IconButton
          title={tr("上传文件夹")}
          disabled={working}
          onClick={() => void planDirectory("upload")}
        >
          <FolderUp size={15} />
        </IconButton>
        <IconButton
          title={tr("新建目录")}
          onClick={() => {
            setOperation({ kind: "mkdir" });
            setValue("");
          }}
        >
          <FolderPlus size={15} />
        </IconButton>
        <IconButton
          title={tr("下载选中的文件或目录")}
          disabled={chosen.length !== 1 || working}
          onClick={() => void download(chosen[0])}
        >
          <Download size={15} />
        </IconButton>
        <IconButton
          title={tr("重命名")}
          disabled={chosen.length !== 1}
          onClick={() => {
            setOperation({ kind: "rename", entry: chosen[0] });
            setValue(chosen[0].name);
          }}
        >
          <Pencil size={14} />
        </IconButton>
        <IconButton
          title={tr("修改权限")}
          disabled={chosen.length !== 1}
          onClick={() => {
            setOperation({ kind: "chmod", entry: chosen[0] });
            setValue(((chosen[0].permissions || 0) & 0o7777).toString(8));
          }}
        >
          <Shield size={14} />
        </IconButton>
        <IconButton
          title={tr("删除选中项目")}
          disabled={!chosen.length || working}
          danger
          onClick={() => void remove()}
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
      {error && <ErrorBox message={error} retry={() => void load()} />}
      <div className="file-explorer" ref={explorerRef}>
        <DirectoryTree key={remote.id} sessionId={remote.id} currentPath={path}
          onNavigate={navigate} width={Math.min(treeWidth, maxTreeWidth)} />
        <ResizeHandle label={tr("调整目录树宽度")} value={Math.min(treeWidth, maxTreeWidth)}
          min={120} max={maxTreeWidth} onChange={onTreeWidth}
          onReset={() => onTreeWidth(defaultWorkspace.fileTreeWidth)} />
        <div className="file-list scroll-area" onContextMenu={(e) => {
          e.preventDefault();
          openContext(e.clientX, e.clientY);
        }}>
        <table className="resizable-file-table" style={{ width: 34 + columnWidths.reduce((sum, width) => sum + width, 0) }}>
          <colgroup><col style={{ width: 34 }} />
            {columnWidths.map((width, i) => <col key={i} style={{ width }} />)}
          </colgroup>
          <thead>
            <tr>
              <th className="check-cell">
                <input
                  aria-label={tr("全选文件")}
                  type="checkbox"
                  checked={
                    filtered.length > 0 &&
                    filtered.every((f) => selected.has(f.path))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? new Set(filtered.map((f) => f.path))
                        : new Set(),
                    )
                  }
                />
              </th>
              {columnLabels.map((label, index) => (
                <th key={label} title={tr(label)} className="resizable-file-heading">
                  <div className="file-heading-content">
                    <span>{tr(label)}</span>
                    <ResizeHandle column label={tr("调整列宽：{0}", tr(label))}
                      value={columnWidths[index]} min={columnMin[index]} max={1400}
                      onChange={(width) => onColumnWidth(index, width)}
                      onReset={() => onColumnWidth(index, defaultWorkspace.fileColumnWidths[index])} />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((entry) => (
              <tr
                key={entry.path}
                className={selected.has(entry.path) ? "selected" : ""}
                onDoubleClick={() => openEntry(entry)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openContext(e.clientX, e.clientY, entry);
                }}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey)
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (next.has(entry.path)) next.delete(entry.path);
                      else next.add(entry.path);
                      return next;
                    });
                  else setSelected(new Set([entry.path]));
                }}
              >
                <td className="check-cell" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={tr("选择 {0}", entry.name)}
                    checked={selected.has(entry.path)}
                    onChange={(e) =>
                      setSelected((old) => {
                        const next = new Set(old);
                        if (e.target.checked) next.add(entry.path);
                        else next.delete(entry.path);
                        return next;
                      })
                    }
                  />
                </td>
                <td className="file-name" title={entry.name}>
                  <div className="file-name-content">
                  {entry.isSymlink ? (
                    <Link2 size={15} className="accent" />
                  ) : entry.isDir ? (
                    <Folder size={15} className="folder-icon" />
                  ) : /\.(json|ya?ml|js|ts|sh|conf|xml|html|css|py|toml|md)$/.test(
                      entry.name,
                    ) ? (
                    <FileCode2 size={15} className="accent" />
                  ) : (
                    <File size={15} />
                  )}
                  <span>{entry.name}</span>
                  </div>
                </td>
                <td>{entry.isDir ? "—" : bytes(entry.size)}</td>
                <td>{entry.isSymlink ? tr("符号链接") : entry.isDir ? tr("文件夹") : tr("文件")}</td>
                <td>
                  {entry.modified
                    ? new Date(entry.modified * 1000).toLocaleString(getLocale(), {
                        year: "numeric", month: "2-digit", day: "2-digit",
                        hour: "2-digit", minute: "2-digit",
                      })
                    : "—"}
                </td>
                <td className="mono">{permissionText(entry)}</td>
                <td className="mono">
                  {entry.uid == null || entry.gid == null ? "—" : `${entry.uid}/${entry.gid}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !error && !filtered.length && (
          <div className="table-empty">{tr("此目录没有可显示的文件")}</div>
        )}
        </div>
      </div>
      <div className="panel-foot">
        <span>
          {filtered.length}{" "}{tr("项")}{selected.size ? tr(" · 已选择 {0} 项", selected.size) : ""}
        </span>
        <input
          className="inline-filter"
          aria-label={tr("筛选文件")}
          placeholder={tr("筛选文件…")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />{tr("显示隐藏文件")}</label>
      </div>
      {menu && createPortal(
        <div
          ref={menuRef}
          className="file-context-menu"
          role="menu"
          aria-label={tr("文件管理菜单")}
          style={{
            left: Math.max(6, Math.min(menu.x, window.innerWidth - 246)),
            top: Math.max(6, Math.min(menu.y, window.innerHeight - 430)),
            maxHeight: Math.max(120, window.innerHeight - Math.max(6, Math.min(menu.y, window.innerHeight - 430)) - 6),
          }}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
            if (!buttons.length) return;
            e.preventDefault();
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            buttons[(index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
          }}
        >
          <button role="menuitem" onClick={() => runMenu(() => void load())}>{tr("刷新")}</button>
          <div className="menu-divider" role="separator" />
          <button role="menuitem" disabled={!canOpen} onClick={() => runMenu(() => openEntry(single!))}>{tr("打开")}</button>
          <button role="menuitem" disabled={!canEdit} aria-expanded={menu.section === "open"} onClick={() => setMenu({ ...menu, section: menu.section === "open" ? null : "open" })}>{tr("打开方式")}<ChevronRight size={13} /></button>
          {menu.section === "open" && canEdit && <div className="file-submenu">
            <button role="menuitem" onClick={() => runMenu(() => openEntry(single!, false))}>{tr("内置代码编辑器")}</button>
            <button role="menuitem" onClick={() => runMenu(() => openEntry(single!, true))}>{tr("纯文本编辑器")}</button>
            <button role="menuitem" onClick={() => runMenu(() => void download(single!))}>{tr("下载本地副本")}</button>
          </div>}
          <button role="menuitem" aria-expanded={menu.section === "editor"} onClick={() => setMenu({ ...menu, section: menu.section === "editor" ? null : "editor" })}>{tr("选择默认文本编辑器")}<ChevronRight size={13} /></button>
          {menu.section === "editor" && <div className="file-submenu">
            <button role="menuitemradio" aria-checked={!defaultPlainEditor} onClick={() => runMenu(() => chooseDefaultEditor(false))}>{tr("内置代码编辑器")}{!defaultPlainEditor && <span>✓</span>}</button>
            <button role="menuitemradio" aria-checked={defaultPlainEditor} onClick={() => runMenu(() => chooseDefaultEditor(true))}>{tr("纯文本编辑器")}{defaultPlainEditor && <span>✓</span>}</button>
          </div>}
          <div className="menu-divider" role="separator" />
          <button role="menuitem" onClick={() => runMenu(() => void copyPaths(menuTargets))}>{tr("复制路径")}</button>
          <div className="menu-divider" role="separator" />
          <button role="menuitem" disabled={!single} onClick={() => runMenu(() => void download(single!))}>{tr("下载")}</button>
          <button role="menuitem" onClick={() => runMenu(() => void upload())}>{tr("上传…")}</button>
          <button role="menuitem" onClick={() => runMenu(() => void planDirectory("upload"))}>{tr("上传文件夹")}</button>
          <div className="menu-divider" role="separator" />
          <button role="menuitem" disabled={!canPack} onClick={() => runMenu(() => void archiveDownload(menuTargets))}>{tr("打包传输 (.tar.gz)")}</button>
          <div className="menu-divider" role="separator" />
          <button role="menuitem" aria-expanded={menu.section === "new"} onClick={() => setMenu({ ...menu, section: menu.section === "new" ? null : "new" })}>{tr("新建")}<ChevronRight size={13} /></button>
          {menu.section === "new" && <div className="file-submenu">
            <button role="menuitem" onClick={() => runMenu(() => showOperation("mkdir"))}>{tr("新建目录")}</button>
            <button role="menuitem" onClick={() => runMenu(() => showOperation("touch"))}>{tr("新建文件")}</button>
          </div>}
          <div className="menu-divider" role="separator" />
          <button role="menuitem" disabled={!single} onClick={() => runMenu(() => showOperation("rename", single))}>{tr("重命名")}</button>
          <button role="menuitem" className="menu-danger" disabled={!menuTargets.length} onClick={() => runMenu(() => void remove(menuTargets))}>{tr("删除")}</button>
          <button role="menuitem" className="menu-danger" disabled={!single?.isDir || single.isSymlink} onClick={() => runMenu(() => void recursiveRemove(single!))}>{tr("递归删除目录…")}</button>
          <div className="menu-divider" role="separator" />
          <button role="menuitem" disabled={!single || single.isSymlink} onClick={() => runMenu(() => showOperation("chmod", single))}>{tr("文件权限…")}</button>
        </div>, document.body)}
      {directoryPlan && (
        <Modal
          title={tr("目录传输预览")}
          subtitle={tr("按计划逐个传输文件，符号链接不会跟随。")}
          onClose={() => setDirectoryPlan(null)}
          footer={
            <>
              <button
                className="button secondary"
                onClick={() => setDirectoryPlan(null)}
              >{tr("取消")}</button>
              <button
                className="button primary"
                disabled={working}
                onClick={() => void startDirectory()}
              >
                {working ? <Busy /> : tr("开始传输")}
              </button>
            </>
          }
        >
          <div className="settings-list">
            <div>
              <span>{tr("本地目录")}</span>
              <strong className="mono">{directoryPlan.localRoot}</strong>
            </div>
            <div>
              <span>{tr("远程目录")}</span>
              <strong className="mono">{directoryPlan.remoteRoot}</strong>
            </div>
            <div>
              <span>{tr("文件数量")}</span>
              <strong>{directoryPlan.totalFiles}</strong>
            </div>
            <div>
              <span>{tr("总大小")}</span>
              <strong>{bytes(directoryPlan.totalBytes)}</strong>
            </div>
            <div>
              <span>{tr("目标已存在")}</span>
              <strong>{directoryPlan.existingFiles}</strong>
            </div>
            <div>
              <span>{tr("跳过的链接")}</span>
              <strong>{directoryPlan.skippedLinks.length}</strong>
            </div>
          </div>
          <Field label={tr("遇到同名文件")}>
            <select
              value={conflict}
              onChange={(e) =>
                setConflict(e.target.value as "skip" | "overwrite")
              }
            >
              <option value="skip">{tr("跳过已有文件（保留目标内容）")}</option>
              {directoryPlan.direction === "upload" && <option value="overwrite">{tr("覆盖已有文件")}</option>}
            </select>
          </Field>
        </Modal>
      )}
      {operation && (
        <Modal
          title={
            { mkdir: tr("新建目录"), touch: tr("新建文件"), rename: tr("重命名"), chmod: tr("修改权限") }[
              operation.kind
            ]
          }
          onClose={() => setOperation(null)}
          footer={
            <>
              <button
                className="button secondary"
                onClick={() => setOperation(null)}
              >{tr("取消")}</button>
              <button
                className="button primary"
                onClick={() => void applyOperation()}
                disabled={working || !value}
              >
                {working ? <Busy /> : tr("确认")}
              </button>
            </>
          }
        >
          <Field
            label={operation.kind === "chmod" ? tr("八进制权限") : tr("名称")}
            hint={
              operation.kind === "chmod"
                ? tr("644：所有者可读写，其他人可读。755：所有者可读写执行，其他人可读执行。")
                : undefined
            }
          >
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void applyOperation();
              }}
              autoFocus
            />
          </Field>
        </Modal>
      )}
      {editing && (
        <Suspense
          fallback={
            <div className="editor-loading">
              <Busy text={tr("正在加载编辑器…")} />
            </div>
          }
        >
          <EditorDialog
            sessionId={remote.id}
            path={editing}
            plainText={plainEditor}
            notify={notify}
            onClose={() => {
              setEditing(null);
              void load();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
