import { tr } from "./i18n";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Pause,
  Play,
  X,
  RefreshCw,
  Plus,
  Trash2,
  Code2,
  Pencil,
  Network,
  Container,
  Square,
  RotateCw,
  FileText,
  ArrowRight,
} from "lucide-react";
import type {
  Transfer,
  Snippet,
  Notify,
  Session,
  Tunnel,
  DockerContainer,
} from "./types";
import { api, bytes, confirmAction, errorText } from "./api";
import { Busy, Empty, ErrorBox, Field, IconButton, Modal } from "./ui";
import { sendTerminalInput } from "./terminalInput";
export function TransferPanel({ notify }: { notify: Notify }) {
  const [tasks, setTasks] = useState<Transfer[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setTasks(await api<Transfer[]>("transfers_list"));
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [load]);
  async function control(id: string, action: string) {
    try {
      await api("transfer_control", { id, action });
      await load();
    } catch (e) {
      notify(errorText(e), "error");
    }
  }
  const labels: Record<string, string> = {
    validating: tr("正在校验"),
    verifying: tr("校验完整性"),
    committing: tr("保存中"),
    pausing: tr("暂停中"),
    cancelling: tr("取消中"),
    queued: tr("等待中"),
    running: tr("传输中"),
    paused: tr("已暂停"),
    failed: tr("失败"),
    completed: tr("已完成"),
    cancelled: tr("已取消"),
    canceled: tr("已取消"),
  };
  return (
    <div className="operation-panel">
      {error && <ErrorBox message={error} retry={() => void load()} />}
      <div className="panel-toolbar">
        <span className="panel-context">{tr("传输队列")}{" "}<span className="count">{tasks.length}</span>
        </span>
        <span className="flex-spacer" />
        <span className="muted">{tr("暂停后会验证已传输内容再续传")}</span>
        <IconButton title={tr("刷新传输队列")} onClick={() => void load()}>
          <RefreshCw size={14} />
        </IconButton>
      </div>
      {tasks.length ? (
        <div className="scroll-area">
          <table className="transfer-table">
            <thead>
              <tr>
                <th>{tr("文件 / 方向")}</th>
                <th>{tr("进度")}</th>
                <th>{tr("速度")}</th>
                <th>{tr("状态")}</th>
                <th>{tr("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const state = t.status.toLowerCase();
                return (
                  <tr key={t.id}>
                    <td>
                      <div className="transfer-name">
                        {t.direction === "upload" ? (
                          <ArrowUpFromLine size={16} className="accent" />
                        ) : (
                          <ArrowDownToLine size={16} className="green" />
                        )}
                        <div>
                          <strong>
                            {(t.direction === "upload"
                              ? t.localPath
                              : t.remotePath
                            )
                              .split(/[\\/]/)
                              .pop()}
                          </strong>
                          <small title={`${t.localPath} ↔ ${t.remotePath}`}>
                            {t.direction === "upload"
                              ? t.remotePath
                              : t.localPath}
                          </small>
                        </div>
                      </div>
                      {t.error && <small className="red">{t.error}</small>}
                    </td>
                    <td className="progress-cell">
                      <div className="progress-track">
                        <span
                          style={{
                            width: `${Math.min(100, t.total ? (t.transferred / t.total) * 100 : 0)}%`,
                          }}
                        />
                      </div>
                      <small>
                        {bytes(t.transferred)} / {bytes(t.total)}
                      </small>
                    </td>
                    <td>{state === "running" ? `${bytes(t.speed)}/s` : "—"}</td>
                    <td>
                      <span className={`status-label ${state}`}>
                        {labels[state] || t.status}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        {state === "running" && (
                          <IconButton
                            title={tr("暂停")}
                            onClick={() => void control(t.id, "pause")}
                          >
                            <Pause size={14} />
                          </IconButton>
                        )}
                        {["paused", "failed"].includes(state) && (
                          <IconButton
                            title={tr("校验并续传")}
                            onClick={() => void control(t.id, "resume")}
                          >
                            <Play size={14} />
                          </IconButton>
                        )}
                        {[
                          "running",
                          "paused",
                          "queued",
                          "failed",
                          "validating",
                          "verifying",
                        ].includes(state) && (
                          <IconButton
                            title={tr("取消传输")}
                            onClick={() => void control(t.id, "cancel")}
                          >
                            <X size={14} />
                          </IconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          icon={<ArrowDownToLine size={25} />}
          title={tr("传输队列为空")}
          text={tr("在文件面板上传或下载文件，进度会显示在这里。")}
        />
      )}
    </div>
  );
}
export function SnippetPanel({
  session,
  notify,
}: {
  session: Session | null;
  notify: Notify;
}) {
  const [items, setItems] = useState<Snippet[]>([]);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [running, setRunning] = useState<Snippet | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setItems(await api<Snippet[]>("snippets_list"));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      await api("snippet_save", { snippet: editing });
      setEditing(null);
      await load();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  async function insert(snippet: Snippet, execute: boolean) {
    if (!session || session.status !== "connected") {
      notify(tr("请先选择一个已连接的终端。"), "info");
      return;
    }
    const keys = [
      ...new Set(
        [...snippet.command.matchAll(/\{\{([\w-]+)\}\}/g)].map((m) => m[1]),
      ),
    ];
    if (keys.length && !running) {
      setRunning(snippet);
      setParams(Object.fromEntries(keys.map((k) => [k, ""])));
      return;
    }
    const command = snippet.command.replace(
      /\{\{([\w-]+)\}\}/g,
      (_match, key) => params[key] ?? `{{${key}}}`,
    );
    if (
      execute &&
      !(await confirmAction(
        tr("将在 {0} 执行：\n\n{1}", session.name, command),
        tr("执行快捷命令"),
      ))
    )
      return;
    try {
      await sendTerminalInput(
        session.id,
        command + (execute ? "\r" : ""),
        session.local,
      );
      setRunning(null);
      notify(execute ? tr("命令已发送。") : tr("已插入终端，按回车执行。"), "success");
    } catch (e) {
      notify(errorText(e), "error");
    }
  }
  return (
    <div className="operation-panel">
      <div className="panel-toolbar">
        <span className="panel-context">{tr("快捷命令")}</span>
        <span className="muted">{tr("支持")}{" "}{tr("{{参数名}}")}{" "}{tr("模板")}</span>
        <span className="flex-spacer" />
        <button
          className="button subtle small"
          onClick={() =>
            setEditing({
              id: crypto.randomUUID(),
              name: "",
              command: "",
              group: "常用命令",
            })
          }
        >
          <Plus size={14} />{tr("新增命令")}</button>
      </div>
      {error && <ErrorBox message={error} />}
      <div className="snippet-grid scroll-area">
        {items.map((s) => (
          <div className="snippet" key={s.id}>
            <header>
              <Code2 size={15} />
              <strong>{s.name}</strong>
              <span>{s.group === "常用命令" ? tr("常用命令") : s.group}</span>
              <IconButton title={tr("编辑命令")} onClick={() => setEditing({ ...s })}>
                <Pencil size={13} />
              </IconButton>
              <IconButton
                title={tr("删除命令")}
                onClick={async () => {
                  if (await confirmAction(tr("删除快捷命令“{0}”？", s.name))) {
                    try {
                      await api("snippet_delete", { id: s.id });
                      await load();
                    } catch (e) {
                      notify(errorText(e), "error");
                    }
                  }
                }}
              >
                <Trash2 size={13} />
              </IconButton>
            </header>
            <code>{s.command}</code>
            <footer>
              <button
                className="text-button"
                onClick={() => void insert(s, false)}
              >{tr("插入终端")}<ArrowRight size={13} />
              </button>
            </footer>
          </div>
        ))}
      </div>
      {!items.length && (
        <Empty
          icon={<Code2 size={24} />}
          title={tr("把常用命令留在手边")}
          text={tr("保存部署、日志和诊断命令，按主机需求填入参数。")}
        />
      )}
      {editing && (
        <Modal
          title={tr("快捷命令")}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button
                className="button secondary"
                onClick={() => setEditing(null)}
              >{tr("取消")}</button>
              <button
                className="button primary"
                disabled={
                  busy || !editing.name.trim() || !editing.command.trim()
                }
                onClick={() => void save()}
              >
                {busy ? <Busy /> : tr("保存")}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <Field label={tr("名称")}>
              <input
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </Field>
            <Field label={tr("分组")}>
              <input
                value={editing.group}
                onChange={(e) =>
                  setEditing({ ...editing, group: e.target.value })
                }
              />
            </Field>
            <Field
              label={tr("命令内容")}
              full
              hint={tr("例如：tail -n 100 {{log_path}}。模板参数按原文代入，请自行正确引用路径。")}
            >
              <textarea
                className="code-input"
                rows={7}
                value={editing.command}
                onChange={(e) =>
                  setEditing({ ...editing, command: e.target.value })
                }
              />
            </Field>
          </div>
        </Modal>
      )}
      {running && (
        <Modal
          title={tr("填写参数 · {0}", running.name)}
          onClose={() => setRunning(null)}
          footer={
            <>
              <button
                className="button secondary"
                onClick={() => void insert(running, false)}
              >{tr("插入终端")}</button>
              <button
                className="button primary"
                onClick={() => void insert(running, true)}
              >{tr("确认执行")}</button>
            </>
          }
        >
          <div className="form-grid">
            {Object.keys(params).map((k) => (
              <Field key={k} label={k} full>
                <input
                  value={params[k]}
                  onChange={(e) =>
                    setParams({ ...params, [k]: e.target.value })
                  }
                />
              </Field>
            ))}
          </div>
          <pre className="command-preview">{running.command}</pre>
        </Modal>
      )}
    </div>
  );
}
export function TunnelPanel({
  session,
  notify,
}: {
  session: Session | null;
  notify: Notify;
}) {
  const [items, setItems] = useState<Tunnel[]>([]);
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<Tunnel["kind"]>("local");
  const [bindPort, setBindPort] = useState(8080);
  const [bindHost, setBindHost] = useState("127.0.0.1");
  const [targetHost, setTargetHost] = useState("127.0.0.1");
  const [targetPort, setTargetPort] = useState(80);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remote =
    session && !session.local && session.status === "connected"
      ? session
      : null;
  const load = useCallback(async () => {
    try {
      setItems(await api<Tunnel[]>("tunnels_list"));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);
  async function start() {
    if (!remote) return;
    setBusy(true);
    setError("");
    try {
      if (
        bindHost !== "127.0.0.1" &&
        bindHost !== "::1" &&
        bindHost !== "localhost" &&
        !(await confirmAction(
          tr("此监听地址可能允许其他设备访问转发服务。确认继续？"),
          tr("开放转发监听"),
        ))
      ) {
        setBusy(false);
        return;
      }
      await api("tunnel_start", {
        sessionId: remote.id,
        kind,
        bindHost,
        bindPort,
        targetHost: kind === "dynamic" ? null : targetHost,
        targetPort: kind === "dynamic" ? null : targetPort,
      });
      setCreating(false);
      await load();
      notify(tr("端口转发已启动。"), "success");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="operation-panel">
      <div className="panel-toolbar">
        <span className="panel-context">{tr("SSH 隧道")}</span>
        <span className="muted">{tr("默认仅监听本机回环地址")}</span>
        <span className="flex-spacer" />
        <button
          className="button subtle small"
          disabled={!remote}
          onClick={() => setCreating(true)}
        >
          <Plus size={14} />{tr("新建转发")}</button>
      </div>
      {error && !creating && <ErrorBox message={error} />}
      <div className="scroll-area">
        {items.length ? (
          <table>
            <thead>
              <tr>
                <th>{tr("类型")}</th>
                <th>{tr("监听地址")}</th>
                <th>{tr("目标地址")}</th>
                <th>{tr("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span className="status-dot connected" />
                    {
                      {
                        local: tr("本地转发"),
                        remote: tr("远程转发"),
                        dynamic: tr("SOCKS5 动态转发"),
                      }[t.kind]
                    }
                  </td>
                  <td className="mono">
                    {t.bindHost}:{t.bindPort}
                  </td>
                  <td className="mono">
                    {t.kind === "dynamic"
                      ? tr("按 SOCKS5 请求")
                      : `${t.targetHost}:${t.targetPort}`}
                  </td>
                  <td>
                    <button
                      className="text-button red"
                      onClick={async () => {
                        try {
                          await api("tunnel_stop", { id: t.id });
                          await load();
                        } catch (e) {
                          notify(errorText(e), "error");
                        }
                      }}
                    >
                      <Square size={12} />{tr("停止")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={<Network size={24} />}
            title={tr("没有运行中的隧道")}
            text={tr("通过 SSH 访问数据库、内网服务，或创建 SOCKS5 代理。")}
          />
        )}
      </div>
      {creating && (
        <Modal
          title={tr("新建端口转发")}
          subtitle={tr("通过 {0}", remote?.name || "")}
          onClose={() => setCreating(false)}
          footer={
            <>
              <button
                className="button secondary"
                onClick={() => setCreating(false)}
              >{tr("取消")}</button>
              <button
                className="button primary"
                disabled={
                  busy ||
                  bindPort < 1 ||
                  bindPort > 65535 ||
                  (!targetPort && kind !== "dynamic")
                }
                onClick={() => void start()}
              >
                {busy ? <Busy /> : tr("启动转发")}
              </button>
            </>
          }
        >
          {error && <ErrorBox message={error} />}
          <div className="form-grid">
            <Field label={tr("转发类型")} full>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as Tunnel["kind"])}
              >
                <option value="local">{tr("本地端口转发（-L）")}</option>
                <option value="remote">{tr("远程端口转发（-R）")}</option>
                <option value="dynamic">{tr("动态 SOCKS5 代理（-D）")}</option>
              </select>
            </Field>
            <Field label={tr("监听地址")}>
              <input
                value={bindHost}
                onChange={(e) => setBindHost(e.target.value)}
              />
            </Field>
            <Field label={tr("监听端口")}>
              <input
                type="number"
                min={1}
                max={65535}
                value={bindPort}
                onChange={(e) => setBindPort(+e.target.value)}
              />
            </Field>
            {kind !== "dynamic" && (
              <>
                <Field
                  label={kind === "remote" ? tr("本地目标地址") : tr("远程目标地址")}
                >
                  <input
                    value={targetHost}
                    onChange={(e) => setTargetHost(e.target.value)}
                  />
                </Field>
                <Field label={tr("目标端口")}>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={targetPort}
                    onChange={(e) => setTargetPort(+e.target.value)}
                  />
                </Field>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
export function DockerPanel({
  session,
  notify,
}: {
  session: Session | null;
  notify: Notify;
}) {
  const [items, setItems] = useState<DockerContainer[]>([]);
  const [images, setImages] = useState<
    {
      id: string;
      repository: string;
      tag: string;
      size: string;
      created: string;
    }[]
  >([]);
  const [view, setView] = useState<"containers" | "images">("containers");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null);
  const remote =
    session && !session.local && session.status === "connected"
      ? session
      : null;
  const load = useCallback(async () => {
    if (!remote) return;
    setBusy(true);
    setError("");
    try {
      if (view === "containers")
        setItems(
          await api<DockerContainer[]>("docker_list", { sessionId: remote.id }),
        );
      else setImages(await api("docker_images", { sessionId: remote.id }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [remote?.id, view]);
  useEffect(() => {
    setItems([]);
    setImages([]);
    setError("");
    void load();
  }, [load]);
  async function action(
    c: DockerContainer,
    action: "start" | "stop" | "restart",
  ) {
    if (!remote) return;
    const label = { start: tr("启动"), stop: tr("停止"), restart: tr("重启") }[action];
    if (
      !(await confirmAction(
        tr("确认{0} {1} 上的容器 {2}？", label, remote.name, c.name),
        tr("容器操作"),
      ))
    )
      return;
    setBusy(true);
    try {
      await api("docker_action", { sessionId: remote.id, id: c.id, action });
      notify(tr("容器已{0}。", label), "success");
      await load();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  if (!remote)
    return (
      <Empty
        icon={<Container size={25} />}
        title={tr("Docker 容器")}
        text={tr("连接 Linux 服务器后，查看容器状态、日志与常用操作。")}
      />
    );
  return (
    <div className="operation-panel">
      <div className="panel-toolbar">
        <button
          className={`button subtle small ${view === "containers" ? "accent" : ""}`}
          onClick={() => setView("containers")}
        >{tr("容器")}{" "}<span className="count">{items.length}</span>
        </button>
        <button
          className={`button subtle small ${view === "images" ? "accent" : ""}`}
          onClick={() => setView("images")}
        >{tr("镜像")}{" "}<span className="count">{images.length}</span>
        </button>
        <span className="muted">{remote.name}</span>
        <span className="flex-spacer" />
        <IconButton
          title={tr("刷新容器")}
          disabled={busy}
          onClick={() => void load()}
        >
          <RefreshCw size={14} className={busy ? "spin" : ""} />
        </IconButton>
      </div>
      {error && <ErrorBox message={error} retry={() => void load()} />}
      <div className="scroll-area">
        {view === "images" ? (
          <>
            {images.length ? (
              <table>
                <thead>
                  <tr>
                    <th>{tr("仓库")}</th>
                    <th>{tr("标签")}</th>
                    <th>{tr("镜像 ID")}</th>
                    <th>{tr("大小")}</th>
                    <th>{tr("创建时间")}</th>
                  </tr>
                </thead>
                <tbody>
                  {images.map((image, i) => (
                    <tr key={image.id + image.repository + image.tag + i}>
                      <td>{image.repository}</td>
                      <td>{image.tag}</td>
                      <td className="mono">
                        {image.id.replace("sha256:", "").slice(0, 12)}
                      </td>
                      <td>{image.size}</td>
                      <td>{image.created}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              !busy &&
              !error && (
                <Empty
                  icon={<Container size={24} />}
                  title={tr("没有镜像")}
                  text={tr("当前服务器没有本地 Docker 镜像。")}
                />
              )
            )}
          </>
        ) : items.length ? (
          <table>
            <thead>
              <tr>
                <th>{tr("容器")}</th>
                <th>{tr("镜像")}</th>
                <th>{tr("状态")}</th>
                <th>{tr("端口")}</th>
                <th>{tr("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="container-name">
                      <Container size={15} />
                      <strong>{c.name}</strong>
                    </div>
                    <small className="mono muted">{c.id.slice(0, 12)}</small>
                  </td>
                  <td>{c.image}</td>
                  <td>
                    <span
                      className={`status-dot ${c.state === "running" ? "connected" : ""}`}
                    />
                    {c.status}
                  </td>
                  <td className="mono">{c.ports || "—"}</td>
                  <td>
                    <div className="row-actions">
                      <IconButton
                        title={tr("查看日志")}
                        onClick={async () => {
                          try {
                            setLogs({
                              name: c.name,
                              text: await api<string>("docker_logs", {
                                sessionId: remote.id,
                                id: c.id,
                              }),
                            });
                          } catch (e) {
                            notify(errorText(e), "error");
                          }
                        }}
                      >
                        <FileText size={14} />
                      </IconButton>
                      {c.state === "running" ? (
                        <>
                          <IconButton
                            title={tr("停止")}
                            disabled={busy}
                            onClick={() => void action(c, "stop")}
                          >
                            <Square size={13} />
                          </IconButton>
                          <IconButton
                            title={tr("重启")}
                            disabled={busy}
                            onClick={() => void action(c, "restart")}
                          >
                            <RotateCw size={14} />
                          </IconButton>
                        </>
                      ) : (
                        <IconButton
                          title={tr("启动")}
                          disabled={busy}
                          onClick={() => void action(c, "start")}
                        >
                          <Play size={14} />
                        </IconButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          !busy &&
          !error && (
            <Empty
              icon={<Container size={24} />}
              title={tr("没有容器")}
              text={tr("当前服务器尚未创建 Docker 容器。")}
            />
          )
        )}
      </div>
      {logs && (
        <Modal
          title={tr("容器日志 · {0}", logs.name)}
          onClose={() => setLogs(null)}
          wide
        >
          <pre className="logs-output">{logs.text || tr("暂无日志")}</pre>
        </Modal>
      )}
    </div>
  );
}
