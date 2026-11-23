import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity, Cpu, MemoryStick, HardDrive, ArrowDown, ArrowUp,
  Clock3, Pause, Play, X, RefreshCw, Server, Network,
  Gauge, Layers3, ShieldCheck,
} from "lucide-react";
import type { AppSettings, MonitorSnapshot, Notify, Session } from "./types";
import { api, bytes, confirmAction, errorText } from "./api";
import { Empty, ErrorBox, IconButton, Modal } from "./ui";

function percentage(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : 0;
}
function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  return d + "天 " + h + "时 " + m + "分";
}
function MetricCard({ icon, label, percent, detail, status = "normal" }: {
  icon: ReactNode; label: string; percent: number | null;
  detail: string; status?: "normal" | "warn" | "danger";
}) {
  return (
    <div className="monitor-metric-card">
      <div className="monitor-metric-heading"><span>{icon}{label}</span><strong>{percent == null ? "—" : percent.toFixed(1) + "%"}</strong></div>
      <div className="monitor-bar" aria-label={label + "使用率"}><span
        className={"monitor-bar-fill " + status}
        style={{ width: (percent ?? 0) + "%" }} /></div>
      <small>{detail}</small>
    </div>
  );
}
function NetworkChart({ samples }: { samples: { rx: number; tx: number }[] }) {
  const max = Math.max(1, ...samples.flatMap((v) => [v.rx, v.tx]));
  const line = (name: "rx" | "tx") =>
    samples.map((item, i) =>
      (i / Math.max(1, samples.length - 1) * 300).toFixed(1) + "," +
      (67 - item[name] / max * 59).toFixed(1)
    ).join(" ");
  return (
    <svg className="monitor-network-chart" viewBox="0 0 300 72" preserveAspectRatio="none" role="img" aria-label="最近网络吞吐量趋势">
      <path d="M0 8H300M0 38H300M0 67H300" fill="none" stroke="var(--border)" strokeWidth="0.7" />
      <polyline points={line("rx")} fill="none" stroke="var(--green)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <polyline points={line("tx")} fill="none" stroke="var(--amber)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
export function MonitorPanel({ session, settings, notify, onClose }: {
  session: Session | null;
  settings: AppSettings;
  notify: Notify;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [networkHistory, setNetworkHistory] = useState<{ rx: number; tx: number }[]>([]);
  const [networkRate, setNetworkRate] = useState({ rx: 0, tx: 0 });
  const [selectedInterface, setSelectedInterface] = useState("all");
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [sampleDuration, setSampleDuration] = useState<number | null>(null);
  const [showProcesses, setShowProcesses] = useState(false);
  const previous = useRef<{ rx: number; tx: number; at: number } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const remote = session && !session.local && session.status === "connected" ? session : null;

  useEffect(() => {
    setSnapshot(null);
    setError("");
    setCpuHistory([]);
    setNetworkHistory([]);
    setSelectedInterface("all");
    setLastUpdated(null);
    previous.current = null;
  }, [session?.id]);
  useEffect(() => {
    previous.current = null;
    setNetworkRate({ rx: 0, tx: 0 });
    setNetworkHistory([]);
  }, [selectedInterface]);
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
        const started = performance.now();
        const data = await api<MonitorSnapshot>("monitor_snapshot", { sessionId: remote.id });
        if (disposed) return;
        const now = Date.now();
        setSnapshot(data);
        setError("");
        setSampleDuration(Math.round(performance.now() - started));
        setLastUpdated(now);
        if (data.cpuPercent != null) {
          setCpuHistory((h) => [...h.slice(-39), data.cpuPercent!]);
        }
        const iface = data.networkInterfaces?.find((item) => item.name === selectedInterface);
        const counters = selectedInterface === "all"
          ? { rx: data.networkRx, tx: data.networkTx } : iface;
        if (counters) {
          if (previous.current && counters.rx >= previous.current.rx && counters.tx >= previous.current.tx) {
            const elapsed = Math.max((now - previous.current.at) / 1000, 0.1);
            const rate = {
              rx: (counters.rx - previous.current.rx) / elapsed,
              tx: (counters.tx - previous.current.tx) / elapsed,
            };
            setNetworkRate(rate);
            setNetworkHistory((h) => [...h.slice(-39), rate]);
          }
          previous.current = { ...counters, at: now };
        } else {
          previous.current = null;
          setNetworkRate({ rx: 0, tx: 0 });
          setNetworkHistory([]);
        }
      } catch (e) {
        if (!disposed) setError(errorText(e));
      }
      if (!disposed) timer = setTimeout(tick, Math.max(2, settings.monitorInterval) * 1000);
    };
    void tick();
    return () => { disposed = true; clearTimeout(timer); };
  }, [remote?.id, paused, settings.monitorInterval, selectedInterface, refresh]);

  const mem = snapshot ? percentage(snapshot.memoryUsed, snapshot.memoryTotal) : null;
  const cpu = snapshot?.cpuPercent ?? null;
  const swap = snapshot?.swapTotal ? percentage(snapshot.swapUsed || 0, snapshot.swapTotal) : null;
  const rootDisk = snapshot ? percentage(snapshot.diskUsed, snapshot.diskTotal) : null;
  const mounts = snapshot?.diskMounts?.length
    ? snapshot.diskMounts
    : snapshot ? [{ path: "/", total: snapshot.diskTotal, used: snapshot.diskUsed, available: Math.max(0, snapshot.diskTotal - snapshot.diskUsed) }] : [];
  const topProcesses = [...(snapshot?.processes || [])].sort((a, b) => b.cpu - a.cpu).slice(0, 5);

  return (
    <aside className="monitor-panel" aria-label="服务器监控">
      <header className="section-heading">
        <span><Activity size={14} /> 实时监控</span>
        <div>
          <IconButton title="立即刷新" onClick={() => setRefresh((v) => v + 1)}><RefreshCw size={14} /></IconButton>
          <IconButton title={paused ? "恢复监控" : "暂停监控"} active={paused}
            onClick={() => setPaused((v) => !v)}>
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </IconButton>
          <IconButton title="隐藏监控" onClick={onClose}><X size={14} /></IconButton>
        </div>
      </header>
      {!remote ? (
        <Empty icon={<Activity size={25} />} title="等待 SSH 连接"
          text="连接 Linux 服务器后显示实际采集的 CPU、内存、交换、网络、磁盘和进程数据。" />
      ) : (
        <div className="monitor-body scroll-area">
          <div className="monitor-identity">
            <span className="status-dot connected" />
            <strong title={snapshot?.hostname || remote.name}>{snapshot?.hostname || remote.name}</strong>
            <span className="monitor-identity-protocol"><ShieldCheck size={12} /> SSH</span>
            {lastUpdated && <small>最近采样 {new Date(lastUpdated).toLocaleTimeString("zh-CN")}</small>}
          </div>
          {error && <ErrorBox message={error} retry={() => setRefresh((r) => r + 1)} />}
          <div className="monitor-summary-grid">
            <section className="monitor-card">
              <h4><Server size={13} /> 系统信息</h4>
              <dl>
                <dt>系统</dt><dd title={snapshot?.os || ""}>{snapshot?.os || "正在读取…"}</dd>
                <dt>内核</dt><dd title={snapshot?.kernel || ""}>{snapshot?.kernel || "—"}</dd>
                <dt>CPU</dt><dd>{snapshot?.cpuCores ? snapshot.cpuCores + " 核" : "—"}</dd>
                <dt>内存</dt><dd>{snapshot ? bytes(snapshot.memoryTotal) : "—"}</dd>
              </dl>
            </section>
            <section className="monitor-card">
              <h4><Clock3 size={13} /> 运行状态</h4>
              <div className="monitor-uptime">{snapshot ? duration(snapshot.uptime) : "—"}</div>
              <h4 className="monitor-subtitle"><Gauge size={13} /> 负载（1/5/15 分钟）</h4>
              <div className="monitor-load">{snapshot ? snapshot.load.map((n) => n.toFixed(2)).join(" / ") : "—"}</div>
            </section>
          </div>
          <div className="monitor-resource-grid">
            <MetricCard icon={<Cpu size={13} />} label="CPU" percent={cpu}
              detail={cpu == null ? "等待下次采样" : "最近采样区间"} status={cpu != null && cpu >= 90 ? "danger" : "normal"} />
            <MetricCard icon={<MemoryStick size={13} />} label="内存" percent={mem}
              detail={snapshot ? bytes(snapshot.memoryUsed) + " / " + bytes(snapshot.memoryTotal) : "—"}
              status={mem != null && mem >= 90 ? "danger" : mem != null && mem >= 80 ? "warn" : "normal"} />
            <MetricCard icon={<Layers3 size={13} />} label="交换" percent={swap}
              detail={snapshot ? snapshot.swapTotal ? bytes(snapshot.swapUsed || 0) + " / " + bytes(snapshot.swapTotal) : "未配置 Swap" : "—"}
              status={swap != null && swap >= 85 ? "warn" : "normal"} />
            <MetricCard icon={<HardDrive size={13} />} label="根磁盘" percent={rootDisk}
              detail={snapshot ? bytes(snapshot.diskUsed) + " / " + bytes(snapshot.diskTotal) : "—"}
              status={rootDisk != null && rootDisk >= 90 ? "danger" : rootDisk != null && rootDisk >= 80 ? "warn" : "normal"} />
          </div>
          <section className="monitor-card">
            <div className="monitor-card-heading">
              <h4><Gauge size={13} /> CPU 近期趋势</h4>
              <small className="muted">{cpuHistory.length ? cpuHistory.length + " 次采样" : "等待采样"}</small>
            </div>
            <svg className="monitor-cpu-chart" viewBox="0 0 300 46" preserveAspectRatio="none" role="img" aria-label="最近 CPU 使用率趋势">
              <path d="M0 1H300M0 23H300M0 45H300" fill="none" stroke="var(--border)" strokeWidth="0.7" />
              <polyline fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke"
                points={cpuHistory.map((n, i) => (i / Math.max(1, cpuHistory.length - 1) * 300).toFixed(1) + "," + (45 - n / 100 * 44).toFixed(1)).join(" ")} />
            </svg>
          </section>
          <section className="monitor-card">
            <div className="monitor-card-heading">
              <h4><Network size={13} /> 网络流量</h4>
              <select className="monitor-traffic-select" value={selectedInterface}
                onChange={(e) => setSelectedInterface(e.target.value)} aria-label="网卡接口">
                <option value="all">全接口</option>
                {(snapshot?.networkInterfaces || []).map((v) =>
                  <option value={v.name} key={v.name}>{v.name}</option>)}
              </select>
            </div>
            <div className="monitor-network-values">
              <span><ArrowDown size={13} className="green" /> 下载 <strong>{snapshot && networkHistory.length ? bytes(networkRate.rx) + "/s" : "采集中…"}</strong></span>
              <span><ArrowUp size={13} className="accent" /> 上传 <strong>{snapshot && networkHistory.length ? bytes(networkRate.tx) + "/s" : "采集中…"}</strong></span>
            </div>
            <NetworkChart samples={networkHistory} />
          </section>
          <section className="monitor-card">
            <div className="monitor-card-heading">
              <h4><Cpu size={13} /> 进程（CPU 排序）</h4>
              <button className="text-button" onClick={() => setShowProcesses(true)}
                disabled={!snapshot?.processes.length}>全部进程</button>
            </div>
            <table className="monitor-process-mini">
              <thead><tr><th>内存</th><th>CPU</th><th>命令</th></tr></thead>
              <tbody>
                {topProcesses.map((p) => <tr key={p.pid}>
                  <td>{snapshot ? bytes(snapshot.memoryTotal * p.memory / 100) : "—"}</td>
                  <td>{p.cpu.toFixed(1)}%</td>
                  <td title={p.command}>{p.command}</td>
                </tr>)}
              </tbody>
            </table>
            {!topProcesses.length && <small className="muted">暂无进程数据</small>}
          </section>
          <section className="monitor-card">
            <h4><HardDrive size={13} /> 磁盘挂载点</h4>
            <div className="monitor-mount-table scroll-area">
              <table><thead><tr><th>路径</th><th>可用 / 总量</th><th>已用</th></tr></thead>
                <tbody>{mounts.map((mount, i) => {
                  const pct = percentage(mount.used, mount.total);
                  return <tr key={mount.path + i}>
                    <td title={mount.path}>{mount.path}</td>
                    <td>{bytes(mount.available)} / {bytes(mount.total)}</td>
                    <td><div className="monitor-mount-usage"><span>{pct.toFixed(0)}%</span>
                      <div className="monitor-bar"><span className={"monitor-bar-fill " + (pct >= 90 ? "danger" : pct >= 80 ? "warn" : "normal")}
                        style={{ width: pct + "%" }} /></div></div></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          </section>
          <footer className="monitor-footer">
            <span className={"status-dot " + (paused ? "" : "connected")} />
            {paused ? "采样已暂停" : "每 " + Math.max(2, settings.monitorInterval) + " 秒采样"}
            {sampleDuration != null && <span title="SSH 命令执行和返回的总耗时，不是 ICMP Ping"> · 本次采样 {sampleDuration} ms</span>}
          </footer>
        </div>
      )}
      {showProcesses && snapshot && (
        <Modal title={"进程 · " + snapshot.hostname} onClose={() => setShowProcesses(false)} wide>
          <div className="process-table scroll-area">
            <table><thead><tr><th>PID</th><th>用户</th><th>CPU</th><th>内存</th><th>命令</th><th>操作</th></tr></thead>
              <tbody>{snapshot.processes.map((p) => <tr key={p.pid}>
                <td>{p.pid}</td><td>{p.user}</td><td>{p.cpu.toFixed(1)}%</td>
                <td>{p.memory.toFixed(1)}%</td>
                <td className="mono truncate" title={p.command}>{p.command}</td>
                <td><button className="text-button red" onClick={async () => {
                  if (!remote || !(await confirmAction(
                    "向 " + p.pid + " (" + p.command + ") 发送 TERM 信号？", "终止进程"))) return;
                  try {
                    await api("process_signal", { sessionId: remote.id, pid: p.pid, signal: "TERM" });
                    setRefresh((n) => n + 1);
                    notify("TERM 信号已发送。", "success");
                  } catch (e) { notify(errorText(e), "error"); }
                }}>终止</button></td>
              </tr>)}</tbody>
            </table>
          </div>
        </Modal>
      )}
    </aside>
  );
}
