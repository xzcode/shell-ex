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
}: {
  session: Session | null;
  notify: Notify;
  onTransfer: () => void;
}) {
  const [path, setPath] = useState(".");
  const [inputPath, setInputPath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [operation, setOperation] = useState<{
    kind: "mkdir" | "rename" | "chmod";
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
  } | null>(null);
  const [conflict, setConflict] = useState<"skip" | "overwrite">("skip");
  const request = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
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
    setPath(next || ".");
    setInputPath(next || ".");
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
            `远程文件 ${joinPath(path, name)} 已存在。是否覆盖？`,
            "覆盖远程文件",
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
      notify("文件已加入传输队列。", "success");
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
      setDirectoryPlan(plan);
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
        `已加入 ${result.queued} 项传输，跳过 ${result.skipped} 项。`,
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
  async function download(entry: FileEntry) {
    if (!remote) return;
    if (entry.isDir) {
      await planDirectory("download", entry);
      return;
    }
    try {
      const destination = await savePath(entry.name);
      if (!destination) return;
      const overwrite = await confirmAction(
        `下载到：${destination}\n若该路径已有文件，完成后将替换它。`,
        "确认下载路径",
      );
      if (!overwrite) return;
      await api("transfer_start", {
        sessionId: remote.id,
        direction: "download",
        localPath: destination,
        remotePath: entry.path,
        overwrite: true,
      });
      notify("下载已加入传输队列。", "success");
      onTransfer();
    } catch (e) {
      notify(errorText(e), "error");
    }
  }
  async function remove() {
    if (!remote || !selected.size) return;
    const targets = entries.filter((f) => selected.has(f.path));
    if (
      !(await confirmAction(
        `将删除 ${targets.length} 项：\n${targets.map((f) => f.name).join("\n")}\n\n删除无法撤销。非空目录不会递归删除。`,
        "删除远程文件",
      ))
    )
      return;
    setWorking(true);
    try {
      for (const f of targets)
        await api("sftp_remove", {
          sessionId: remote.id,
          path: f.path,
          isDir: f.isDir,
        });
      notify("已删除选中的项目。", "success");
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
      if (operation.kind === "mkdir") {
        if (!value || value.includes("/") || value === "." || value === "..")
          throw new Error("请输入单个目录名称。");
        await api("sftp_mkdir", {
          sessionId: remote.id,
          path: joinPath(path, value),
        });
      } else if (operation.kind === "rename") {
        if (!value || value.includes("/") || value === "." || value === "..")
          throw new Error("请输入单个文件名。");
        await api("sftp_rename", {
          sessionId: remote.id,
          from: operation.entry!.path,
          to: joinPath(parentPath(operation.entry!.path), value),
        });
      } else {
        if (!/^[0-7]{3,4}$/.test(value))
          throw new Error("权限应为三到四位八进制，例如 644、755。");
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
        title={session?.local ? "本地终端已打开" : "远程文件"}
        text={
          session?.local
            ? "连接 SSH 服务器后，在这里管理远程文件。"
            : "连接服务器后，安全浏览、传输和编辑文件。"
        }
      />
    );
  const filtered = entries.filter(
    (e) =>
      (showHidden || !e.name.startsWith(".")) &&
      e.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const chosen = entries.filter((e) => selected.has(e.path));
  return (
    <div className="file-panel" ref={panel}>
      <div className="panel-toolbar">
        <IconButton title="上一级" onClick={() => navigate(parentPath(path))}>
          <ArrowUp size={15} />
        </IconButton>
        <IconButton title="用户主目录" onClick={() => navigate(".")}>
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
            aria-label="远程目录"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
          />
          <button title="打开目录">
            <ChevronRight size={14} />
          </button>
        </form>
        <IconButton
          title="刷新文件列表"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? "spin" : ""} />
        </IconButton>
        <span className="toolbar-separator" />
        <button className="button subtle small" onClick={() => void upload()}>
          <Upload size={14} />
          上传
        </button>
        <IconButton
          title="上传文件夹"
          disabled={working}
          onClick={() => void planDirectory("upload")}
        >
          <FolderUp size={15} />
        </IconButton>
        <IconButton
          title="新建目录"
          onClick={() => {
            setOperation({ kind: "mkdir" });
            setValue("");
          }}
        >
          <FolderPlus size={15} />
        </IconButton>
        <IconButton
          title="下载选中的文件或目录"
          disabled={chosen.length !== 1 || working}
          onClick={() => void download(chosen[0])}
        >
          <Download size={15} />
        </IconButton>
        <IconButton
          title="重命名"
          disabled={chosen.length !== 1}
          onClick={() => {
            setOperation({ kind: "rename", entry: chosen[0] });
            setValue(chosen[0].name);
          }}
        >
          <Pencil size={14} />
        </IconButton>
        <IconButton
          title="修改权限"
          disabled={chosen.length !== 1}
          onClick={() => {
            setOperation({ kind: "chmod", entry: chosen[0] });
            setValue(((chosen[0].permissions || 0) & 0o7777).toString(8));
          }}
        >
          <Shield size={14} />
        </IconButton>
        <IconButton
          title="删除选中项目"
          disabled={!chosen.length || working}
          danger
          onClick={() => void remove()}
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
      {error && <ErrorBox message={error} retry={() => void load()} />}
      <div className="file-explorer">
        <DirectoryTree key={remote.id} sessionId={remote.id} currentPath={path}
          onNavigate={navigate} />
        <div className="file-list scroll-area">
        <table>
          <thead>
            <tr>
              <th className="check-cell">
                <input
                  aria-label="全选文件"
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
              <th>文件名</th>
              <th>大小</th>
              <th>类型</th>
              <th>修改时间</th>
              <th>权限</th>
              <th>用户/用户组</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((entry) => (
              <tr
                key={entry.path}
                className={selected.has(entry.path) ? "selected" : ""}
                onDoubleClick={() =>
                  entry.isDir ? navigate(entry.path) : setEditing(entry.path)
                }
                onClick={() => setSelected(new Set([entry.path]))}
              >
                <td className="check-cell" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${entry.name}`}
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
                <td className="file-name">
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
                </td>
                <td>{entry.isDir ? "—" : bytes(entry.size)}</td>
                <td>{entry.isSymlink ? "符号链接" : entry.isDir ? "文件夹" : "文件"}</td>
                <td>
                  {entry.modified
                    ? new Date(entry.modified * 1000).toLocaleString("zh-CN", {
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
          <div className="table-empty">此目录没有可显示的文件</div>
        )}
        </div>
      </div>
      <div className="panel-foot">
        <span>
          {filtered.length} 项
          {selected.size ? ` · 已选择 ${selected.size} 项` : ""}
        </span>
        <input
          className="inline-filter"
          aria-label="筛选文件"
          placeholder="筛选文件…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          显示隐藏文件
        </label>
      </div>
      {directoryPlan && (
        <Modal
          title="目录传输预览"
          subtitle="按计划逐个传输文件，符号链接不会跟随。"
          onClose={() => setDirectoryPlan(null)}
          footer={
            <>
              <button
                className="button secondary"
                onClick={() => setDirectoryPlan(null)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={working}
                onClick={() => void startDirectory()}
              >
                {working ? <Busy /> : "开始传输"}
              </button>
            </>
          }
        >
          <div className="settings-list">
            <div>
              <span>本地目录</span>
              <strong className="mono">{directoryPlan.localRoot}</strong>
            </div>
            <div>
              <span>远程目录</span>
              <strong className="mono">{directoryPlan.remoteRoot}</strong>
            </div>
            <div>
              <span>文件数量</span>
              <strong>{directoryPlan.totalFiles}</strong>
            </div>
            <div>
              <span>总大小</span>
              <strong>{bytes(directoryPlan.totalBytes)}</strong>
            </div>
            <div>
              <span>目标已存在</span>
              <strong>{directoryPlan.existingFiles}</strong>
            </div>
            <div>
              <span>跳过的链接</span>
              <strong>{directoryPlan.skippedLinks.length}</strong>
            </div>
          </div>
          <Field label="遇到同名文件">
            <select
              value={conflict}
              onChange={(e) =>
                setConflict(e.target.value as "skip" | "overwrite")
              }
            >
              <option value="skip">跳过已有文件（保留目标内容）</option>
              <option value="overwrite">覆盖已有文件</option>
            </select>
          </Field>
        </Modal>
      )}
      {operation && (
        <Modal
          title={
            { mkdir: "新建目录", rename: "重命名", chmod: "修改权限" }[
              operation.kind
            ]
          }
          onClose={() => setOperation(null)}
          footer={
            <>
              <button
                className="button secondary"
                onClick={() => setOperation(null)}
              >
                取消
              </button>
              <button
                className="button primary"
                onClick={() => void applyOperation()}
                disabled={working || !value}
              >
                {working ? <Busy /> : "确认"}
              </button>
            </>
          }
        >
          <Field
            label={operation.kind === "chmod" ? "八进制权限" : "名称"}
            hint={
              operation.kind === "chmod"
                ? "644：所有者可读写，其他人可读。755：所有者可读写执行，其他人可读执行。"
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
              <Busy text="正在加载编辑器…" />
            </div>
          }
        >
          <EditorDialog
            sessionId={remote.id}
            path={editing}
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
