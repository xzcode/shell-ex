import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Cpu,
  MemoryStick,
  HardDrive,
  ArrowDown,
  ArrowUp,
  Clock3,
  Pause,
  Play,
  X,
  RefreshCw,
} from "lucide-react";
import type { AppSettings, MonitorSnapshot, Notify, Session } from "./types";
import { api, bytes, confirmAction, errorText } from "./api";
import { Empty, ErrorBox, IconButton, Modal } from "./ui";
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const points = values
    .map(
      (v, i) =>
        `${(i / Math.max(values.length - 1, 1)) * 180},${32 - (Math.min(100, Math.max(0, v)) / 100) * 28}`,
    )
    .join(" ");
  return (
    <svg
      viewBox="0 0 180 36"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="sparkline"
    >
      <path d="M0 32 H180" stroke="var(--border)" strokeWidth="1" />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
export function MonitorPanel({
  session,
  settings,
  notify,
  onClose,
}: {
  session: Session | null;
  settings: AppSettings;
  notify: Notify;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [history, setHistory] = useState<number[]>([]);
  const [net, setNet] = useState({ rx: 0, tx: 0 });
  const [processes, setProcesses] = useState(false);
  const previous = useRef<{ rx: number; tx: number; at: number } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const remote =
    session && !session.local && session.status === "connected"
      ? session
      : null;
  useEffect(() => {
    setSnapshot(null);
    setError("");
    setHistory([]);
    previous.current = null;
  }, [session?.id]);
  useEffect(() => {
    if (!remote || paused) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.hidden) {
        timer = setTimeout(tick, 10000);
        return;
      }
      try {
        const data = await api<MonitorSnapshot>("monitor_snapshot", {
          sessionId: remote.id,
        });
        if (disposed) return;
        setSnapshot(data);
        setError("");
        if (data.cpuPercent !== null)
          setHistory((h) => [...h.slice(-44), data.cpuPercent!]);
        const at = Date.now();
        if (previous.current) {
          const seconds = Math.max((at - previous.current.at) / 1000, 0.1);
          setNet({
            rx: Math.max(0, (data.networkRx - previous.current.rx) / seconds),
            tx: Math.max(0, (data.networkTx - previous.current.tx) / seconds),
          });
        }
        previous.current = { rx: data.networkRx, tx: data.networkTx, at };
      } catch (e) {
        if (!disposed) setError(errorText(e));
      }
      if (!disposed)
        timer = setTimeout(tick, Math.max(2, settings.monitorInterval) * 1000);
    };
    void tick();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [remote?.id, paused, settings.monitorInterval, refresh]);
  const mem =
    snapshot && snapshot.memoryTotal
      ? (snapshot.memoryUsed / snapshot.memoryTotal) * 100
      : 0;
  const disk =
    snapshot && snapshot.diskTotal
      ? (snapshot.diskUsed / snapshot.diskTotal) * 100
      : 0;
  return (
    <aside className="monitor-panel">
      <header className="section-heading">
        <span>
          <Activity size={14} />
          系统监控
        </span>
        <div>
          <IconButton
            title={paused ? "恢复监控" : "暂停监控"}
            active={paused}
            onClick={() => setPaused((v) => !v)}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </IconButton>
          <IconButton title="隐藏监控" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
      </header>
      {!remote ? (
        <Empty
          icon={<Activity size={25} />}
          title="等待连接"
          text="CPU、内存与网络状态将在连接后显示。"
        />
      ) : (
        <div className="monitor-body scroll-area">
          {error && (
            <ErrorBox message={error} retry={() => setRefresh((r) => r + 1)} />
          )}
          <div className="machine-summary">
            <div className="machine-logo">L</div>
            <div>
              <strong>{snapshot?.hostname || remote.name}</strong>
              <small>{snapshot?.os || "Linux · 正在读取系统信息"}</small>
            </div>
          </div>
          <div className="metric">
            <div className="metric-heading">
              <span>
                <Cpu size={14} />
                CPU
              </span>
              <strong>
                {snapshot?.cpuPercent == null
                  ? "—"
                  : `${snapshot.cpuPercent.toFixed(1)}%`}
              </strong>
            </div>
            <Sparkline values={history} color="var(--accent)" />
            <small>
              负载{" "}
              {snapshot
                ? snapshot.load.map((n) => n.toFixed(2)).join(" / ")
                : "— / — / —"}
            </small>
          </div>
          <div className="metric">
            <div className="metric-heading">
              <span>
                <MemoryStick size={14} />
                内存
              </span>
              <strong>{snapshot ? `${mem.toFixed(1)}%` : "—"}</strong>
            </div>
            <div className="metric-bar">
              <span
                style={{
                  width: `${Math.min(mem, 100)}%`,
                  background: "var(--green)",
                }}
              />
            </div>
            <small>
              {snapshot
                ? `${bytes(snapshot.memoryUsed)} / ${bytes(snapshot.memoryTotal)}`
                : "等待采集"}
            </small>
          </div>
          <div className="metric">
            <div className="metric-heading">
              <span>
                <HardDrive size={14} />
                系统磁盘 /
              </span>
              <strong>{snapshot ? `${disk.toFixed(1)}%` : "—"}</strong>
            </div>
            <div className="metric-bar">
              <span
                style={{
                  width: `${Math.min(disk, 100)}%`,
                  background: disk > 90 ? "var(--red)" : "var(--amber)",
                }}
              />
            </div>
            <small>
              {snapshot
                ? `${bytes(snapshot.diskUsed)} / ${bytes(snapshot.diskTotal)}`
                : "等待采集"}
            </small>
          </div>
          <div className="metric">
            <div className="metric-heading">
              <span>
                <Activity size={14} />
                网络
              </span>
              <small>全接口汇总</small>
            </div>
            <div className="network-rates">
              <span>
                <ArrowDown size={14} className="green" />
                <strong>
                  {snapshot ? bytes(net.rx) : "—"}
                  <small>/s</small>
                </strong>
              </span>
              <span>
                <ArrowUp size={14} className="accent" />
                <strong>
                  {snapshot ? bytes(net.tx) : "—"}
                  <small>/s</small>
                </strong>
              </span>
            </div>
          </div>
          <div className="uptime">
            <Clock3 size={13} />
            <span>运行时间</span>
            <strong>
              {snapshot
                ? `${Math.floor(snapshot.uptime / 86400)} 天 ${Math.floor((snapshot.uptime % 86400) / 3600)} 小时`
                : "—"}
            </strong>
          </div>
          <div className="process-header">
            <strong>进程</strong>
            <button className="text-button" onClick={() => setProcesses(true)}>
              查看详情
            </button>
          </div>
          <div className="process-mini">
            {snapshot?.processes.slice(0, 5).map((p) => (
              <div key={p.pid}>
                <span title={p.command}>
                  {p.command.split("/").pop()?.split(" ")[0]}
                </span>
                <small>{p.cpu.toFixed(1)}%</small>
              </div>
            ))}
            {!snapshot?.processes.length && (
              <small className="muted">暂无进程数据</small>
            )}
          </div>
          <footer className="monitor-footer">
            <span className={`status-dot ${paused ? "" : "connected"}`} />
            {paused
              ? "采样已暂停"
              : `每 ${Math.max(2, settings.monitorInterval)} 秒采样`}
            <RefreshCw size={11} />
          </footer>
        </div>
      )}
      {processes && snapshot && (
        <Modal
          title={`进程 · ${snapshot.hostname}`}
          onClose={() => setProcesses(false)}
          wide
        >
          <div className="process-table scroll-area">
            <table>
              <thead>
                <tr>
                  <th>PID</th>
                  <th>用户</th>
                  <th>CPU</th>
                  <th>内存</th>
                  <th>命令</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.processes.map((p) => (
                  <tr key={p.pid}>
                    <td>{p.pid}</td>
                    <td>{p.user}</td>
                    <td>{p.cpu.toFixed(1)}%</td>
                    <td>{p.memory.toFixed(1)}%</td>
                    <td className="mono truncate" title={p.command}>
                      {p.command}
                    </td>
                    <td>
                      <button
                        className="text-button red"
                        onClick={async () => {
                          if (
                            !remote ||
                            !(await confirmAction(
                              `向 ${p.pid} (${p.command}) 发送 TERM 信号？`,
                              "终止进程",
                            ))
                          )
                            return;
                          try {
                            await api("process_signal", {
                              sessionId: remote.id,
                              pid: p.pid,
                              signal: "TERM",
                            });
                            setRefresh((r) => r + 1);
                            notify("TERM 信号已发送。", "success");
                          } catch (e) {
                            notify(errorText(e), "error");
                          }
                        }}
                      >
                        终止
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </aside>
  );
}
