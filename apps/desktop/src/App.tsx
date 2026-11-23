import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import {
  Server,
  TerminalSquare,
  Search,
  Plus,
  ChevronDown,
  ChevronRight,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  PanelBottom,
  PanelRight,
  Columns2,
  Rows2,
  Maximize2,
  X,
  Folder,
  ArrowDownUp,
  Code2,
  Network,
  Container,
  ShieldCheck,
  Star,
  MoreHorizontal,
  Pencil,
  Copy,
  Trash2,
  ArrowUpRight,
  CircleHelp,
  Command,
  Check,
  AlertCircle,
  LoaderCircle,
  Monitor,
  LockKeyhole,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import type {
  AppSettings,
  AuthRequest,
  Host,
  HostKeyInfo,
  Notify,
  SecretInput,
  Session,
  TerminalEvent,
  Workspace,
} from "./types";
import { defaultSettings, defaultWorkspace } from "./types";
import { api, confirmAction, errorText, native } from "./api";
import { Busy, ErrorBox, Field, IconButton, Modal } from "./ui";
import { HostDialog, TrustDialog } from "./HostDialog";
import {
  TerminalView,
  forgetTerminal,
  receiveTerminalEvent,
} from "./TerminalView";
import { FilePanel } from "./FilePanel";
import {
  DockerPanel,
  SnippetPanel,
  TransferPanel,
  TunnelPanel,
} from "./OperationsPanels";
import { MonitorPanel } from "./MonitorPanel";
import { SettingsDialog } from "./SettingsDialog";
import { hasDirtyDrafts } from "./drafts";
type Toast = {
  id: number;
  message: string;
  kind: "success" | "error" | "info";
};
type SecretPrompt = {
  host: Host;
  resolve: (secret: SecretInput | null) => void;
};
const labels: Record<string, string> = {
  connected: "已连接",
  connecting: "连接中",
  authenticating: "认证中",
  disconnected: "连接中断",
  closed: "已关闭",
  closing: "正在关闭",
  error: "连接失败",
  failed: "连接失败",
  reconnecting: "重连中",
};
const panelItems = [
  { id: "files", name: "文件", icon: Folder },
  { id: "transfers", name: "传输", icon: ArrowDownUp },
  { id: "snippets", name: "快捷命令", icon: Code2 },
  { id: "tunnels", name: "隧道", icon: Network },
  { id: "docker", name: "Docker", icon: Container },
];
export default function App() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [workspace, setWorkspace] = useState<Workspace>(defaultWorkspace);
  const [ready, setReady] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hostDialog, setHostDialog] = useState<Host | null | undefined>(
    undefined,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [panel, setPanel] = useState("files");
  const [hostMenu, setHostMenu] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<Set<string>>(new Set());
  const [trust, setTrust] = useState<{
    host: Host;
    info: HostKeyInfo;
    resolve: (yes: boolean) => void;
  } | null>(null);
  const [secretPrompt, setSecretPrompt] = useState<SecretPrompt | null>(null);
  const [authRequests, setAuthRequests] = useState<AuthRequest[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [bootError, setBootError] = useState("");
  const [help, setHelp] = useState(false);
  const connectionLock = useRef(false);
  const closingSessions = useRef(new Set<string>());
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const sessionRef = useRef(sessions);
  sessionRef.current = sessions;
  const statusRef = useRef(
    new Map<string, { status: string; error?: string }>(),
  );
  const restoreRef = useRef<string[]>([]);
  const initialized = useRef(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reconnecting = useRef(new Set<string>());
  const reconnectAttempts = useRef(new Map<string, number>());
  const active = sessions.find((s) => s.id === activeId) || null;
  const notify: Notify = useCallback((message, kind = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, kind }]);
    setTimeout(
      () => setToasts((t) => t.filter((n) => n.id !== id)),
      kind === "error" ? 10000 : 5000,
    );
  }, []);
  const reloadHosts = useCallback(async () => {
    setHosts(await api<Host[]>("hosts_list"));
  }, []);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    Promise.all([
      api<Host[]>("hosts_list"),
      api<AppSettings>("settings_get"),
      api<Workspace>("workspace_get"),
    ])
      .then(([h, s, w]) => {
        setHosts(h);
        setSettings({ ...defaultSettings, ...s });
        setWorkspace({
          ...defaultWorkspace,
          ...w,
          sidebarWidth: Math.min(360, Math.max(196, w.sidebarWidth || 236)),
          filesHeight: Math.min(480, Math.max(150, w.filesHeight || 254)),
        });
        restoreRef.current = w.hostIds || [];
        setReady(true);
      })
      .catch((e) => {
        setBootError(errorText(e));
        setReady(true);
      });
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      const hostIds = [
        ...new Set(sessions.filter((s) => s.hostId).map((s) => s.hostId!)),
      ];
      const data = {
        ...workspace,
        hostIds: hostIds.length ? hostIds : restoreRef.current,
        activeHostId: active?.hostId || null,
      };
      void api("workspace_save", { workspace: data }).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [workspace, sessions, active?.hostId, ready]);
  function onEvent(event: TerminalEvent) {
    if (
      (event.type === "state" &&
        ["failed", "closed", "error", "disconnected"].includes(event.state)) ||
      event.type === "exit"
    )
      setAuthRequests((list) =>
        list.filter((r) => r.sessionId !== event.sessionId),
      );
    if (event.type === "auth") {
      setAuthRequests((r) => [...r, event]);
      return;
    }
    receiveTerminalEvent(event);
    if (event.type === "state" || event.type === "exit") {
      const status = event.type === "exit" ? "closed" : event.state;
      const error = event.type === "state" ? event.message : undefined;
      statusRef.current.set(event.sessionId, { status, error });
      setSessions((list) =>
        list.map((s) =>
          s.id === event.sessionId
            ? {
                ...s,
                status: s.terminalFailure ? "error" : status,
                error: s.terminalFailure || error,
              }
            : s,
        ),
      );
    }
  }
  function terminalTransportFailure(sessionId: string, message: string) {
    const session = sessionRef.current.find((s) => s.id === sessionId);
    if (
      !session ||
      closingSessions.current.has(sessionId) ||
      ["closed", "disconnected", "failed", "error"].includes(session.status)
    )
      return;
    notify(`${session.name}：${message}。正在关闭会话，请重新连接。`, "error");
    setSessions((list) =>
      list.map((s) =>
        s.id === sessionId
          ? { ...s, status: "error", error: message, terminalFailure: message }
          : s,
      ),
    );
    closingSessions.current.add(sessionId);
    void api("session_close", { sessionId, local: session.local })
      .catch((error) => {
        notify(
          `关闭 ${session.name} 未完成：${errorText(error)}。请关闭该会话或退出应用。`,
          "error",
        );
      })
      .finally(() => {
        closingSessions.current.delete(sessionId);
        setSessions((list) => [...list]);
      });
  }
  async function connectHost(host: Host, automatic = false): Promise<boolean> {
    let secret: SecretInput | null = null;
    if (connectionLock.current) {
      if (!automatic) notify("请先完成当前连接的身份核验。", "info");
      return false;
    }
    if (hasDirtyDrafts()) {
      if (automatic) return false;
      if (
        !(await confirmAction(
          "新连接成功后将切换工作台，当前未保存的文件修改会被放弃。",
          "打开新会话",
        ))
      )
        return false;
    }
    if (connecting.has(host.id)) return false;
    if (!native) {
      notify("当前是界面预览，请使用桌面应用连接 SSH 服务器。", "info");
      return false;
    }
    connectionLock.current = true;
    setConnecting((s) => new Set(s).add(host.id));
    setHostMenu(null);
    setPalette(false);
    try {
      if (
        host.jumpHostId &&
        !sessionRef.current.some(
          (s) => s.hostId === host.jumpHostId && s.status === "connected",
        )
      )
        throw new Error("请先连接并验证此主机配置的跳板机，再连接目标服务器。");
      const info = await api<HostKeyInfo>("ssh_probe", { hostId: host.id });
      if (!info.trusted) {
        if (automatic)
          throw new Error("主机指纹需要手动核验，已暂停自动重连。");
        const accept = await new Promise<boolean>((resolve) =>
          setTrust({ host, info, resolve }),
        );
        if (!accept) return false;
      }
      if (host.authMethod === "password" || host.authMethod === "key") {
        let saved = false;
        try {
          saved = await api<boolean>("host_secret_status", { id: host.id });
        } catch (e) {
          if (automatic) throw e;
          notify("系统凭据库暂不可用，将使用本次连接的临时凭据。", "info");
        }
        if (!saved) {
          if (automatic) throw new Error("没有已保存的凭据，请手动重新连接。");
          secret = await new Promise<SecretInput | null>((resolve) =>
            setSecretPrompt({ host, resolve }),
          );
          if (!secret) return false;
        }
      }
      const onEventChannel = new Channel<TerminalEvent>();
      onEventChannel.onmessage = onEvent;
      const id = await api<string>("ssh_connect", {
        hostId: host.id,
        secret,
        onEvent: onEventChannel,
      });
      if (secret) {
        secret.password = null;
        secret.passphrase = null;
      }
      const pending = statusRef.current.get(id);
      setSessions((list) => [
        ...list,
        {
          id,
          hostId: host.id,
          name: host.name,
          local: false,
          status: pending?.status || "connected",
          error: pending?.error,
          connectedAt: Date.now(),
        },
      ]);
      if (!automatic) await selectSession(id);
      else if (
        sessionRef.current.find((s) => s.id === activeRef.current)?.hostId ===
        host.id
      )
        setActiveId(id);
      restoreRef.current = [];
      reconnectAttempts.current.delete(host.id);
      notify(`已连接 ${host.name}。`, "success");
      return true;
    } catch (e) {
      notify(errorText(e), "error");
      return false;
    } finally {
      connectionLock.current = false;
      if (secret) {
        secret.password = null;
        secret.passphrase = null;
      }
      setConnecting((s) => {
        const next = new Set(s);
        next.delete(host.id);
        return next;
      });
    }
  }
  async function selectSession(id: string) {
    if (
      id !== activeId &&
      hasDirtyDrafts() &&
      !(await confirmAction(
        "文件编辑器有未保存的修改。切换终端会放弃当前编辑。",
        "切换会话",
      ))
    )
      return;
    setActiveId(id);
  }
  async function openLocal() {
    if (
      hasDirtyDrafts() &&
      !(await confirmAction(
        "打开本地终端会切换工作台并放弃当前未保存的文件修改。",
        "打开本地终端",
      ))
    )
      return;
    if (!native) {
      notify("本地终端需要在 Shell EX 桌面应用中打开。", "info");
      return;
    }
    try {
      const channel = new Channel<TerminalEvent>();
      channel.onmessage = onEvent;
      const id = await api<string>("local_open", {
        cwd: null,
        cols: 100,
        rows: 30,
        onEvent: channel,
      });
      setSessions((s) => [
        ...s,
        {
          id,
          hostId: null,
          name: "本地终端",
          local: true,
          status: "connected",
          connectedAt: Date.now(),
        },
      ]);
      await selectSession(id);
      setPalette(false);
    } catch (e) {
      notify(errorText(e), "error");
    }
  }
  async function closeSession(session: Session, force = false) {
    if (
      !force &&
      (session.status === "connected" || hasDirtyDrafts()) &&
      !(await confirmAction(
        `关闭“${session.name}”会终止此终端和相关隧道，并取消关联传输。${hasDirtyDrafts() ? "编辑器尚有未保存修改，将被放弃。" : ""}`,
        "关闭会话",
      ))
    )
      return;
    closingSessions.current.add(session.id);
    const reconnectTimer = timers.current.get(session.id);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    timers.current.delete(session.id);
    reconnecting.current.delete(session.id);
    setSessions((list) =>
      list.map((s) => (s.id === session.id ? { ...s, status: "closing" } : s)),
    );
    try {
      await api("session_close", {
        sessionId: session.id,
        local: session.local,
      });
    } catch (e) {
      notify(errorText(e), "error");
      setSessions((list) =>
        list.map((s) =>
          s.id === session.id
            ? {
                ...s,
                status: "error",
                error: `关闭会话未完成：${errorText(e)}`,
              }
            : s,
        ),
      );
      return;
    } finally {
      closingSessions.current.delete(session.id);
    }
    forgetTerminal(session.id);
    setSessions((s) => s.filter((item) => item.id !== session.id));
    if (activeId === session.id) {
      const others = sessions.filter((s) => s.id !== session.id);
      setActiveId(others.at(-1)?.id || null);
    }
    const timer = timers.current.get(session.id);
    if (timer) clearTimeout(timer);
    timers.current.delete(session.id);
  }
  useEffect(() => {
    if (!settings.autoReconnect || !native) return;
    for (const s of sessions) {
      if (
        s.local ||
        !s.hostId ||
        !["disconnected", "closed", "error", "failed"].includes(s.status) ||
        closingSessions.current.has(s.id) ||
        reconnecting.current.has(s.id)
      )
        continue;
      const host = hosts.find((h) => h.id === s.hostId);
      if (!host) continue;
      reconnecting.current.add(s.id);
      const attempt = async (count: number) => {
        if (
          !sessionRef.current.some((x) => x.id === s.id) ||
          closingSessions.current.has(s.id) ||
          hasDirtyDrafts()
        )
          return;
        const timer = setTimeout(async () => {
          timers.current.delete(s.id);
          if (
            !sessionRef.current.some((x) => x.id === s.id) ||
            closingSessions.current.has(s.id) ||
            hasDirtyDrafts()
          )
            return;
          const ok = await connectHost(host, true);
          if (ok) {
            void api("session_close", { sessionId: s.id, local: false }).catch(
              () => {},
            );
            forgetTerminal(s.id);
            setSessions((list) => list.filter((x) => x.id !== s.id));
          } else if (count < 2) void attempt(count + 1);
        }, [2000, 5000, 12000][count]);
        timers.current.set(s.id, timer);
      };
      void attempt(0);
    }
  }, [sessions, settings.autoReconnect]);
  useEffect(() => {
    const closeHandler = () => setHostMenu(null);
    document.addEventListener("click", closeHandler);
    return () => document.removeEventListener("click", closeHandler);
  }, []);
  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || document.querySelector(".modal")) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(true);
        setPaletteQuery("");
      }
      if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
      if (e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setHostDialog(null);
      }
      if (e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        void openLocal();
      }
    };
    document.addEventListener("keydown", keyHandler);
    return () => document.removeEventListener("keydown", keyHandler);
  });
  useEffect(() => {
    if (!native) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onCloseRequested(async (event) => {
          if (
            !hasDirtyDrafts() &&
            !sessionRef.current.some((s) => s.status === "connected")
          )
            return;
          event.preventDefault();
          if (
            await confirmAction(
              hasDirtyDrafts()
                ? "编辑器有未保存的修改。退出会放弃修改，关闭会话并取消传输。"
                : "退出将关闭所有终端和隧道，并取消正在运行的传输。请确认重要任务已保存。",
              "退出 Shell EX",
            )
          ) {
            for (const session of sessionRef.current)
              closingSessions.current.add(session.id);
            for (const timer of timers.current.values()) clearTimeout(timer);
            timers.current.clear();
            setSessions((list) =>
              list.map((session) => ({ ...session, status: "closing" })),
            );
            await Promise.allSettled(
              sessionRef.current.map((s) =>
                api("session_close", { sessionId: s.id, local: s.local }),
              ),
            );
            await getCurrentWindow().destroy();
          }
        }),
      )
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => notify(errorText(e), "error"));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  async function deleteHost(host: Host) {
    if (
      sessions.some((s) => s.hostId === host.id && s.status === "connected")
    ) {
      notify("请先关闭此主机的会话。", "info");
      return;
    }
    if (
      !(await confirmAction(`删除“${host.name}”及其保存的凭据？`, "删除连接"))
    )
      return;
    try {
      await api("host_delete", { id: host.id });
      await reloadHosts();
    } catch (e) {
      notify(errorText(e), "error");
    }
  }
  async function saveSettings(next: AppSettings) {
    const saved = await api<AppSettings>("settings_save", { settings: next });
    setSettings(saved);
    notify("设置已保存。", "success");
  }
  function dragDimension(e: React.PointerEvent, kind: "sidebar" | "files") {
    e.preventDefault();
    const startX = e.clientX,
      startY = e.clientY;
    const initial =
      kind === "sidebar" ? workspace.sidebarWidth : workspace.filesHeight;
    const move = (event: PointerEvent) =>
      setWorkspace((w) => ({
        ...w,
        ...(kind === "sidebar"
          ? {
              sidebarWidth: Math.max(
                196,
                Math.min(360, initial + event.clientX - startX),
              ),
            }
          : {
              filesHeight: Math.max(
                150,
                Math.min(
                  window.innerHeight - 240,
                  initial + startY - event.clientY,
                ),
              ),
            }),
      }));
    const end = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.body.style.cursor = "";
    };
    document.body.style.cursor =
      kind === "sidebar" ? "col-resize" : "row-resize";
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
  }
  const visibleHosts = hosts.filter((h) =>
    `${h.name} ${h.address} ${h.username} ${h.group}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const groups = [...new Set(visibleHosts.map((h) => h.group || "默认分组"))];
  const secondary = sessions.filter((s) => s.id !== activeId).at(-1);
  const splitEnabled = workspace.split !== "none" && !!secondary;
  const remembered = restoreRef.current
    .map((id) => hosts.find((h) => h.id === id))
    .filter((h): h is Host => !!h);
  const renderHost = (host: Host, slot: string) => {
    const connected = sessions.some(
      (s) => s.hostId === host.id && s.status === "connected",
    );
    const pending = connecting.has(host.id);
    return (
      <div
        className={`host-item${active?.hostId === host.id ? " active" : ""}`}
        key={host.id}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={() => void connectHost(host)}
      >
        <button
          className="host-main"
          onClick={() => {
            const open = sessions.find((s) => s.hostId === host.id);
            if (open) void selectSession(open.id);
          }}
          title={`双击连接 ${host.username}@${host.address}:${host.port}`}
        >
          <span className="host-icon" style={{ color: host.color }}>
            <Server size={16} />
            <i
              className={connected ? "connected" : pending ? "connecting" : ""}
            />
          </span>
          <span>
            <strong>{host.name}</strong>
            <small>{host.address}</small>
          </span>
          {host.favorite && <Star className="favorite" size={11} />}
        </button>
        <IconButton
          title={`${host.name} 更多操作`}
          onClick={() => {
            setHostMenu(hostMenu === slot + host.id ? null : slot + host.id);
          }}
        >
          <MoreHorizontal size={15} />
        </IconButton>
        {hostMenu === slot + host.id && (
          <div className="context-menu" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => void connectHost(host)}>
              <TerminalSquare size={14} />
              连接服务器
            </button>
            <button
              onClick={() => {
                setHostDialog(host);
                setHostMenu(null);
              }}
            >
              <Pencil size={14} />
              编辑连接
            </button>
            <button
              onClick={() => {
                setHostDialog({
                  ...host,
                  id: crypto.randomUUID(),
                  name: `${host.name} 副本`,
                });
                setHostMenu(null);
              }}
            >
              <Copy size={14} />
              复制配置
            </button>
            <button
              onClick={async () => {
                try {
                  await api("host_save", {
                    host: { ...host, favorite: !host.favorite },
                    rememberSecret: false,
                  });
                  await reloadHosts();
                  setHostMenu(null);
                } catch (e) {
                  notify(errorText(e), "error");
                }
              }}
            >
              <Star size={14} />
              {host.favorite ? "取消收藏" : "加入收藏"}
            </button>
            <button className="red" onClick={() => void deleteHost(host)}>
              <Trash2 size={14} />
              删除连接
            </button>
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">›_</span>
          <strong>Shell EX</strong>
          <span className="version-tag">0.1</span>
        </div>
        <div className="header-center">
          <button
            className="command-trigger"
            onClick={() => {
              setPalette(true);
              setPaletteQuery("");
            }}
          >
            <Search size={14} />
            <span>搜索主机与操作</span>
            <kbd>⌘ K</kbd>
          </button>
        </div>
        <div className="header-actions">
          <span className={`environment-label${!native ? " preview" : ""}`}>
            {native ? (
              <>
                <LockKeyhole size={12} />
                本地工作台
              </>
            ) : (
              <>
                <Monitor size={12} />
                界面预览
              </>
            )}
          </span>
          <span className="toolbar-separator" />
          <IconButton title="设置 ⌘," onClick={() => setSettingsOpen(true)}>
            <Settings size={17} />
          </IconButton>
        </div>
      </header>
      <div className="workspace-shell">
        {sidebar && (
          <>
            <aside
              className="sidebar"
              style={{ width: workspace.sidebarWidth }}
            >
              <header className="sidebar-heading">
                <strong>连接</strong>
                <span>{hosts.length}</span>
                <div className="flex-spacer" />
                <IconButton
                  title="新建连接 ⌘⇧N"
                  onClick={() => setHostDialog(null)}
                >
                  <Plus size={17} />
                </IconButton>
              </header>
              <div className="host-search">
                <Search size={13} />
                <input
                  placeholder="筛选主机…"
                  aria-label="筛选主机"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                {filter && (
                  <button onClick={() => setFilter("")}>
                    <X size={12} />
                  </button>
                )}
              </div>
              <div className="host-groups scroll-area">
                {hosts.some((h) => h.favorite) && !filter && (
                  <section className="host-group">
                    <button
                      className="group-heading"
                      onClick={() =>
                        setCollapsed((c) => {
                          const n = new Set(c);
                          if (n.has("__favorites")) n.delete("__favorites");
                          else n.add("__favorites");
                          return n;
                        })
                      }
                    >
                      {collapsed.has("__favorites") ? (
                        <ChevronRight size={12} />
                      ) : (
                        <ChevronDown size={12} />
                      )}
                      <Star size={12} />
                      <span>收藏</span>
                    </button>
                    {!collapsed.has("__favorites") &&
                      hosts
                        .filter((h) => h.favorite)
                        .map((h) => renderHost(h, "favorite"))}
                  </section>
                )}
                {groups.map((group) => (
                  <section className="host-group" key={group}>
                    <button
                      className="group-heading"
                      onClick={() =>
                        setCollapsed((c) => {
                          const n = new Set(c);
                          if (n.has(group)) n.delete(group);
                          else n.add(group);
                          return n;
                        })
                      }
                    >
                      {collapsed.has(group) ? (
                        <ChevronRight size={12} />
                      ) : (
                        <ChevronDown size={12} />
                      )}
                      <FolderOpen size={12} />
                      <span>{group}</span>
                      <small>
                        {
                          visibleHosts.filter(
                            (h) => (h.group || "默认分组") === group,
                          ).length
                        }
                      </small>
                    </button>
                    {!collapsed.has(group) &&
                      visibleHosts
                        .filter((h) => (h.group || "默认分组") === group)
                        .map((h) => renderHost(h, "group"))}
                  </section>
                ))}
                {!hosts.length && (
                  <div className="sidebar-empty">
                    <Server size={26} />
                    <strong>还没有连接</strong>
                    <p>
                      添加你的第一台服务器
                      <br />
                      开始管理远程工作。
                    </p>
                    <button
                      className="button secondary small"
                      onClick={() => setHostDialog(null)}
                    >
                      <Plus size={13} />
                      添加连接
                    </button>
                  </div>
                )}
                {!!hosts.length && !visibleHosts.length && (
                  <p className="sidebar-no-results">没有匹配的主机</p>
                )}
              </div>
              <div className="sidebar-bottom">
                <button onClick={() => void openLocal()}>
                  <TerminalSquare size={16} />
                  <span>本地终端</span>
                  <kbd>⌘⇧L</kbd>
                </button>
                <button onClick={() => setHelp(true)}>
                  <CircleHelp size={16} />
                  <span>使用指南</span>
                  <ArrowUpRight size={13} />
                </button>
              </div>
            </aside>
            <div
              className="resize-handle vertical"
              onPointerDown={(e) => dragDimension(e, "sidebar")}
              role="separator"
              aria-label="调整侧边栏宽度"
              aria-orientation="vertical"
            />
          </>
        )}
        <main className="workbench">
          <div className="session-bar">
            <IconButton
              title={sidebar ? "收起主机列表" : "显示主机列表"}
              onClick={() => setSidebar((v) => !v)}
            >
              {sidebar ? (
                <PanelLeftClose size={15} />
              ) : (
                <PanelLeftOpen size={15} />
              )}
            </IconButton>
            <div className="session-tabs">
              {!sessions.length ? (
                <div className="session-tab selected welcome-tab">
                  <TerminalSquare size={14} />
                  工作台
                </div>
              ) : (
                sessions.map((s) => (
                  <div
                    key={s.id}
                    className={`session-tab${s.id === activeId ? " selected" : ""}`}
                    onClick={() => void selectSession(s.id)}
                  >
                    <span className={`status-dot ${s.status}`} />
                    <span>{s.name}</span>
                    {s.local && <small>本地</small>}
                    <button
                      aria-label={`关闭 ${s.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void closeSession(s);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <IconButton
              title="新建会话"
              onClick={() => {
                setPalette(true);
                setPaletteQuery("");
              }}
            >
              <Plus size={16} />
            </IconButton>
            <span className="toolbar-separator" />
            <IconButton
              title="左右分屏"
              active={workspace.split === "horizontal"}
              disabled={sessions.length < 2}
              onClick={() =>
                setWorkspace((w) => ({
                  ...w,
                  split: w.split === "horizontal" ? "none" : "horizontal",
                }))
              }
            >
              <Columns2 size={15} />
            </IconButton>
            <IconButton
              title="上下分屏"
              active={workspace.split === "vertical"}
              disabled={sessions.length < 2}
              onClick={() =>
                setWorkspace((w) => ({
                  ...w,
                  split: w.split === "vertical" ? "none" : "vertical",
                }))
              }
            >
              <Rows2 size={15} />
            </IconButton>
            <IconButton
              title="专注模式"
              onClick={async () => {
                if (
                  hasDirtyDrafts() &&
                  !(await confirmAction(
                    "专注模式将关闭文件面板并放弃当前未保存的修改。",
                    "进入专注模式",
                  ))
                )
                  return;
                setSidebar(false);
                setWorkspace((w) => ({
                  ...w,
                  filesVisible: false,
                  monitorVisible: false,
                }));
              }}
            >
              <Maximize2 size={14} />
            </IconButton>
          </div>
          <div className="workspace-main">
            <section className="terminal-column">
              {bootError && <ErrorBox message={bootError} />}
              <div
                className={`terminal-area ${splitEnabled ? "split-" + workspace.split : ""}`}
              >
                {sessions.length ? (
                  sessions.map((s) => (
                    <div
                      key={s.id}
                      className={`terminal-slot${s.id === activeId ? " primary" : splitEnabled && s.id === secondary?.id ? " secondary" : " hidden"}`}
                      onMouseDown={() => {
                        if (s.id !== activeId && workspace.split === "none")
                          setActiveId(s.id);
                      }}
                    >
                      <TerminalView
                        session={s}
                        settings={settings}
                        visible={
                          s.id === activeId ||
                          (splitEnabled && s.id === secondary?.id)
                        }
                        notify={notify}
                        onTransportFailure={terminalTransportFailure}
                      />
                      {s.status !== "connected" && (
                        <div className="disconnected-banner">
                          <AlertCircle size={14} />
                          <span>
                            {labels[s.status] || s.status} ·{" "}
                            {s.error || "重新连接将打开新会话"}
                          </span>
                          {s.hostId && (
                            <button
                              className="text-button"
                              onClick={() => {
                                const h = hosts.find((h) => h.id === s.hostId);
                                if (h) void connectHost(h);
                              }}
                            >
                              <RefreshCw size={13} />
                              重新连接
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="welcome-screen">
                    <div className="welcome-heading">
                      <div className="welcome-symbol">
                        <TerminalSquare size={30} strokeWidth={1.3} />
                      </div>
                      <span className="eyebrow">SHELL EX WORKSPACE</span>
                      <h1>从一台服务器开始。</h1>
                      <p>终端、文件与系统状态，在同一个工作空间。</p>
                    </div>
                    <div className="welcome-actions">
                      <button
                        className="button primary"
                        onClick={() => setHostDialog(null)}
                      >
                        <Plus size={16} />
                        新建 SSH 连接
                      </button>
                      <button
                        className="button secondary"
                        onClick={() => void openLocal()}
                      >
                        <TerminalSquare size={16} />
                        打开本地终端
                      </button>
                    </div>
                    {remembered.length > 0 && (
                      <div className="restore-workspace">
                        <span>上次工作区 · {remembered.length} 台主机</span>
                        <button
                          className="text-button"
                          onClick={async () => {
                            for (const h of remembered) await connectHost(h);
                            restoreRef.current = [];
                          }}
                        >
                          重新连接
                          <ArrowUpRight size={13} />
                        </button>
                      </div>
                    )}
                    <div className="welcome-details">
                      <div>
                        <ShieldCheck size={17} />
                        <strong>安全连接</strong>
                        <span>验证主机身份，保护凭据</span>
                      </div>
                      <div>
                        <Folder size={17} />
                        <strong>文件随手可及</strong>
                        <span>SFTP 传输与远程编辑</span>
                      </div>
                      <div>
                        <Network size={17} />
                        <strong>适应你的网络</strong>
                        <span>代理、跳板机与端口转发</span>
                      </div>
                    </div>
                    <div className="welcome-shortcuts">
                      <span>
                        快速查找<kbd>⌘ K</kbd>
                      </span>
                      <span>
                        新建连接<kbd>⌘ ⇧ N</kbd>
                      </span>
                      <span>
                        设置<kbd>⌘ ,</kbd>
                      </span>
                    </div>
                  </div>
                )}
                {connecting.size > 0 && (
                  <div className="connecting-overlay">
                    <LoaderCircle size={15} className="spin" />
                    正在连接 {connecting.size} 台主机…
                  </div>
                )}
              </div>
              {workspace.filesVisible && (
                <>
                  <div
                    className="resize-handle horizontal"
                    onPointerDown={(e) => dragDimension(e, "files")}
                    role="separator"
                    aria-label="调整文件面板高度"
                    aria-orientation="horizontal"
                  />
                  <section
                    className="bottom-panel"
                    style={{ height: workspace.filesHeight }}
                  >
                    <header className="panel-tabs">
                      {panelItems.map((item) => (
                        <button
                          key={item.id}
                          className={panel === item.id ? "active" : ""}
                          onClick={async () => {
                            if (
                              hasDirtyDrafts() &&
                              !(await confirmAction(
                                "编辑器有未保存的修改。切换面板将暂时隐藏编辑器，返回文件面板可继续编辑。",
                                "切换面板",
                              ))
                            )
                              return;
                            setPanel(item.id);
                          }}
                        >
                          <item.icon size={14} />
                          {item.name}
                        </button>
                      ))}
                      <span className="flex-spacer" />
                      <IconButton
                        title="隐藏工具面板"
                        onClick={async () => {
                          if (
                            hasDirtyDrafts() &&
                            !(await confirmAction(
                              "隐藏面板将放弃当前编辑器未保存的修改。",
                              "隐藏面板",
                            ))
                          )
                            return;
                          setWorkspace((w) => ({ ...w, filesVisible: false }));
                        }}
                      >
                        <X size={14} />
                      </IconButton>
                    </header>
                    <div className="bottom-panel-content">
                      <div
                        className="persistent-file-panel"
                        style={{ display: panel === "files" ? "flex" : "none" }}
                      >
                        <FilePanel
                          session={active}
                          notify={notify}
                          onTransfer={() => setPanel("transfers")}
                        />
                      </div>
                      {panel === "transfers" && (
                        <TransferPanel notify={notify} />
                      )}
                      {panel === "snippets" && (
                        <SnippetPanel session={active} notify={notify} />
                      )}
                      {panel === "tunnels" && (
                        <TunnelPanel session={active} notify={notify} />
                      )}
                      {panel === "docker" && (
                        <DockerPanel session={active} notify={notify} />
                      )}
                    </div>
                  </section>
                </>
              )}
            </section>
            {workspace.monitorVisible && (
              <MonitorPanel
                session={active}
                settings={settings}
                notify={notify}
                onClose={() =>
                  setWorkspace((w) => ({ ...w, monitorVisible: false }))
                }
              />
            )}
          </div>
        </main>
      </div>
      <footer className="statusbar">
        <div>
          <ShieldCheck size={12} />
          <span>
            {sessions.filter((s) => s.status === "connected").length} 个连接
          </span>
          <span className="status-separator" />
          {active ? (
            <>
              <span className={`status-dot ${active.status}`} />
              <span>
                {active.local ? "本地 PTY" : "SSH"} ·{" "}
                {labels[active.status] || active.status}
              </span>
            </>
          ) : (
            <span>{native ? "就绪" : "预览模式 · SSH 功能需桌面应用"}</span>
          )}
        </div>
        <div>
          <span>UTF-8</span>
          <span>xterm-256color</span>
          <IconButton
            title="显示工具面板"
            active={workspace.filesVisible}
            onClick={async () => {
              if (
                workspace.filesVisible &&
                hasDirtyDrafts() &&
                !(await confirmAction(
                  "隐藏面板将放弃当前编辑器未保存的修改。",
                  "隐藏面板",
                ))
              )
                return;
              setWorkspace((w) => ({ ...w, filesVisible: !w.filesVisible }));
            }}
          >
            <PanelBottom size={13} />
          </IconButton>
          <IconButton
            title="显示监控面板"
            active={workspace.monitorVisible}
            onClick={() =>
              setWorkspace((w) => ({ ...w, monitorVisible: !w.monitorVisible }))
            }
          >
            <PanelRight size={13} />
          </IconButton>
        </div>
      </footer>
      {hostDialog !== undefined && (
        <HostDialog
          host={hostDialog}
          hosts={hosts}
          notify={notify}
          onClose={() => {
            setHostDialog(undefined);
            void reloadHosts();
          }}
          onSaved={() => {
            setHostDialog(undefined);
            void reloadHosts();
            notify("连接已保存。", "success");
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          hosts={hosts}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
          notify={notify}
          onHostsChanged={() => void reloadHosts()}
        />
      )}
      {trust && (
        <TrustDialog
          host={trust.host}
          info={trust.info}
          onClose={() => {
            trust.resolve(false);
            setTrust(null);
          }}
          onTrust={async () => {
            await api("ssh_trust", {
              hostId: trust.host.id,
              algorithm: trust.info.algorithm,
              fingerprint: trust.info.fingerprint,
              replace: trust.info.changed,
            });
            trust.resolve(true);
            setTrust(null);
          }}
        />
      )}
      {secretPrompt && (
        <CredentialPrompt
          prompt={secretPrompt}
          onDone={(secret) => {
            secretPrompt.resolve(secret);
            setSecretPrompt(null);
          }}
        />
      )}
      {authRequests[0] && (
        <AuthDialog
          request={authRequests[0]}
          onDone={async (responses) => {
            try {
              await api("ssh_auth_respond", {
                requestId: authRequests[0].requestId,
                responses,
              });
            } catch (e) {
              notify(errorText(e), "error");
            }
            setAuthRequests((r) => r.slice(1));
          }}
        />
      )}
      {palette && (
        <Modal title="快速连接" onClose={() => setPalette(false)}>
          <div className="palette-input">
            <Search size={18} />
            <input
              autoFocus
              placeholder="输入主机名称、地址或用户名…"
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
            />
            <kbd>ESC</kbd>
          </div>
          <div className="palette-results">
            {hosts
              .filter((h) =>
                `${h.name} ${h.address} ${h.username}`
                  .toLowerCase()
                  .includes(paletteQuery.toLowerCase()),
              )
              .map((h) => (
                <button key={h.id} onClick={() => void connectHost(h)}>
                  <Server size={17} />
                  <span>
                    <strong>{h.name}</strong>
                    <small>
                      {h.username}@{h.address}:{h.port}
                    </small>
                  </span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
            <button
              onClick={() => {
                setPalette(false);
                setHostDialog(null);
              }}
            >
              <Plus size={17} />
              <span>
                <strong>新建 SSH 连接</strong>
                <small>添加服务器到工作台</small>
              </span>
              <kbd>⌘⇧N</kbd>
            </button>
            <button onClick={() => void openLocal()}>
              <TerminalSquare size={17} />
              <span>
                <strong>打开本地终端</strong>
                <small>使用本机默认 Shell</small>
              </span>
              <kbd>⌘⇧L</kbd>
            </button>
          </div>
        </Modal>
      )}
      {help && (
        <Modal
          title="使用指南"
          subtitle="Shell EX · 快捷上手"
          onClose={() => setHelp(false)}
        >
          <div className="help-list">
            <section>
              <span>01</span>
              <div>
                <h3>添加并连接服务器</h3>
                <p>
                  保存主机地址与认证方式，双击主机连接。首次连接请核对服务器指纹，再输入凭据。
                </p>
              </div>
            </section>
            <section>
              <span>02</span>
              <div>
                <h3>终端与文件一起工作</h3>
                <p>
                  底部文件面板支持双击目录与文件。拖入本地文件开始上传；传输面板可查看进度、暂停和取消。
                </p>
              </div>
            </section>
            <section>
              <span>03</span>
              <div>
                <h3>配置自己的工作台</h3>
                <p>
                  拖动面板边界调整尺寸。连接多个终端后可左右或上下分屏。快捷命令支持参数模板。
                </p>
              </div>
            </section>
            <section>
              <span>04</span>
              <div>
                <h3>备份与长期会话</h3>
                <p>
                  在设置中导出加密备份。网络断开后重连会创建新会话，持续运行的远程任务建议放入
                  tmux。
                </p>
              </div>
            </section>
          </div>
          <div className="info-note">
            <Command size={17} />
            <p>
              macOS 使用 ⌘ 快捷键；Windows 与 Linux 使用 Ctrl。终端中的 Ctrl+C
              保持发送中断信号。
            </p>
          </div>
        </Modal>
      )}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div className={`toast ${t.kind}`} key={t.id}>
            {t.kind === "error" ? (
              <AlertCircle size={16} />
            ) : t.kind === "success" ? (
              <Check size={16} />
            ) : (
              <CircleHelp size={16} />
            )}
            <span>{t.message}</span>
            <button
              aria-label="关闭提示"
              onClick={() =>
                setToasts((ts) => ts.filter((item) => item.id !== t.id))
              }
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
function CredentialPrompt({
  prompt,
  onDone,
}: {
  prompt: SecretPrompt;
  onDone: (secret: SecretInput | null) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Modal
      title={prompt.host.authMethod === "key" ? "私钥口令" : "登录凭据"}
      subtitle={`${prompt.host.username}@${prompt.host.address}`}
      onClose={() => {
        setValue("");
        onDone(null);
      }}
      footer={
        <>
          <button
            className="button secondary"
            onClick={() => {
              setValue("");
              onDone(null);
            }}
          >
            取消
          </button>
          <button
            className="button primary"
            onClick={() => {
              onDone(
                prompt.host.authMethod === "key"
                  ? { passphrase: value || null }
                  : { password: value },
              );
              setValue("");
            }}
          >
            连接
          </button>
        </>
      }
    >
      <Field
        label={
          prompt.host.authMethod === "key"
            ? "私钥口令（未加密私钥可留空）"
            : "密码"
        }
        hint="仅本次连接使用，不会保存。可在连接配置中选择保存到系统凭据库。"
      >
        <input
          autoFocus
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onDone(
                prompt.host.authMethod === "key"
                  ? { passphrase: value || null }
                  : { password: value },
              );
              setValue("");
            }
          }}
        />
      </Field>
    </Modal>
  );
}
function AuthDialog({
  request,
  onDone,
}: {
  request: AuthRequest;
  onDone: (responses: string[]) => Promise<void>;
}) {
  const [values, setValues] = useState(request.prompts.map(() => ""));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValues(request.prompts.map(() => ""));
    setBusy(false);
  }, [request.requestId]);
  async function submit() {
    setBusy(true);
    await onDone(values);
    setValues([]);
  }
  return (
    <Modal
      title={request.name || "交互式认证"}
      subtitle={
        request.instructions || "请回答服务器的认证请求。回答不会保存。"
      }
      onClose={() => void onDone([])}
      footer={
        <>
          <button className="button secondary" onClick={() => void onDone([])}>
            取消认证
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? <Busy /> : "提交认证"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        {request.prompts.map((p, i) => (
          <Field label={p.prompt || `认证信息 ${i + 1}`} key={i} full>
            <input
              type={p.echo ? "text" : "password"}
              autoComplete="off"
              value={values[i] || ""}
              onChange={(e) =>
                setValues((v) =>
                  v.map((s, j) => (j === i ? e.target.value : s)),
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </Field>
        ))}
      </div>
    </Modal>
  );
}
