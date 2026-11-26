import { tr, getLocale } from "./i18n";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity, Cpu, MemoryStick, HardDrive, ArrowDown, ArrowUp,
  Clock3, Pause, Play, X, RefreshCw, Server, Network,
  Gauge, Layers3, ShieldCheck, ExternalLink, PanelRight,
} from "lucide-react";
import type { AppSettings, MonitorSnapshot, Notify, Session } from "./types";
import { api, bytes, confirmAction, errorText } from "./api";
import { Empty, ErrorBox, IconButton, Modal } from "./ui";
import { MonitorChart } from "./MonitorChart";
import { MonitorTable } from "./MonitorTable";
import { StorageMonitor, DiskIoMonitor } from "./StorageMonitor";
import { appendDiskHistory, sortProcesses, useMonitorPreference, type DiskHistory, type ProcessSort, type ProcessSortKey } from "./monitorModel";

const miniColumns = [
  { label: "内存", width: 80, min: 64, sortKey: "memory" },
  { label: "CPU", width: 65, min: 48, sortKey: "cpu" },
  { label: "命令", width: 145, min: 80 },
] as const;
const processColumns = [
  { label: "PID", width: 65, min: 50, sortKey: "pid" },
  { label: "用户", width: 95, min: 65, sortKey: "user" },
  { label: "CPU", width: 70, min: 48, sortKey: "cpu" },
  { label: "内存", width: 90, min: 60, sortKey: "memory" },
  { label: "命令", width: 220, min: 100, sortKey: "command" },
  { label: "操作", width: 85, min: 65 },
] as const;
const PAGE_SIZE = 100;
const pctText = (value: number | null | undefined) => value == null ? "—" : value.toFixed(1) + "%";

function percentage(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : 0;
}
function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  return d + tr("天 ") + h + tr("时 ") + m + tr("分");
}
function MetricCard({ icon, label, percent, detail, status = "normal" }: {
  icon: ReactNode; label: string; percent: number | null;
  detail: string; status?: "normal" | "warn" | "danger";
}) {
  return (
    <div className="monitor-metric-card">
      <div className="monitor-metric-heading"><span>{icon}{label}</span><strong>{percent == null ? "—" : percent.toFixed(1) + "%"}</strong></div>
      <div className="monitor-bar" aria-label={label + tr("使用率")}><span
        className={"monitor-bar-fill " + status}
        style={{ width: (percent ?? 0) + "%" }} /></div>
      <small>{detail}</small>
    </div>
  );
}
export function MonitorPanel({ session, settings, notify, onClose, width, onDetach, onDock, docking = false }: {
  session: Pick<Session, "id" | "name" | "local" | "status"> | null;
  settings: Pick<AppSettings, "monitorInterval">;
  width?: number;
  onDetach?: () => void;
  onDock?: () => void;
  docking?: boolean;
  notify: Notify;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [cpuHistory, setCpuHistory] = useState<{ at: number; value: number }[]>([]);
  const [networkHistory, setNetworkHistory] = useState<{ at: number; rx: number; tx: number }[]>([]);
  const [networkRate, setNetworkRate] = useState({ rx: 0, tx: 0 });
  const [selectedInterface, setSelectedInterface] = useState("all");
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [sampleDuration, setSampleDuration] = useState<number | null>(null);
  const [showProcesses, setShowProcesses] = useState(false);
  const [processOrder, setProcessOrder] = useMonitorPreference("process-order-v1", ["cpu", "memory"] as const, "cpu");
  const [processSort, setProcessSort] = useState<ProcessSort>({ key: "cpu", direction: "desc" });
  const [processQuery, setProcessQuery] = useState("");
  const [processPage, setProcessPage] = useState(0);
  const [diskHistory, setDiskHistory] = useState<DiskHistory>({});
  const previous = useRef<{ rx: number; tx: number; at: number } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const remote = session && !session.local && session.status === "connected" ? session : null;
  const detached = !!onDock;

  useEffect(() => {
    setSnapshot(null);
    setError("");
    setCpuHistory([]);
    setNetworkHistory([]);
    setSelectedInterface("all");
    setLastUpdated(null);
    setSampleDuration(null);
    setShowProcesses(false);
    setDiskHistory({});
    setProcessQuery("");
    setProcessPage(0);
    setNetworkRate({ rx: 0, tx: 0 });
    previous.current = null;
  }, [remote?.id]);
  useEffect(() => {
    previous.current = null;
    setNetworkRate({ rx: 0, tx: 0 });
    setNetworkHistory([]);
  }, [selectedInterface]);
  useEffect(() => {
    if (!remote || paused || docking) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.hidden) {
        timer = setTimeout(tick, 10000);
        return;
      }
      try {
        const started = performance.now();
        const data = await api<MonitorSnapshot>(detached ? "monitor_window_snapshot" : "monitor_snapshot", { sessionId: remote.id });
        if (disposed) return;
        const now = Date.now();
        setSnapshot(data);
        setDiskHistory((old) => appendDiskHistory(old, data.diskIo || [], now));
        setError("");
        setSampleDuration(Math.round(performance.now() - started));
        setLastUpdated(now);
        if (data.cpuPercent != null) {
          setCpuHistory((h) => [...h.slice(-39), { at: now, value: data.cpuPercent! }]);
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
            setNetworkHistory((h) => [...h.slice(-39), { at: now, ...rate }]);
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
  }, [remote?.id, paused, settings.monitorInterval, selectedInterface, refresh, detached, docking]);

  const mem = snapshot ? percentage(snapshot.memoryUsed, snapshot.memoryTotal) : null;
  const cpu = snapshot?.cpuPercent ?? null;
  const swap = snapshot?.swapTotal ? percentage(snapshot.swapUsed || 0, snapshot.swapTotal) : null;
  const rootMount = snapshot?.diskMounts?.find((mount) => mount.path === "/");
  const rootDisk = rootMount && rootMount.used + rootMount.available > 0
    ? percentage(rootMount.used, rootMount.used + rootMount.available) : null;
  const topProcesses = useMemo(() => sortProcesses((snapshot?.processes || []).filter((p) => processOrder === "cpu" ? p.cpu != null : p.rssBytes != null), { key: processOrder, direction: "desc" }).slice(0, 5), [snapshot, processOrder]);
  const allProcesses = useMemo(() => showProcesses ? sortProcesses(snapshot?.processes || [], processSort, processQuery) : [],
    [snapshot, showProcesses, processSort, processQuery]);
  const pageCount = Math.max(1, Math.ceil(allProcesses.length / PAGE_SIZE));
  const pageIndex = Math.min(processPage, pageCount - 1);
  function openProcesses() {
    setProcessSort({ key: processOrder, direction: "desc" });
    setProcessPage(0);
    setProcessQuery("");
    setShowProcesses(true);
  }
  function changeProcessSort(key: ProcessSortKey) {
    setProcessSort((old) => ({ key, direction: old.key === key
      ? old.direction === "desc" ? "asc" : "desc"
      : key === "cpu" || key === "memory" ? "desc" : "asc" }));
    setProcessPage(0);
  }

  return (
    <aside className="monitor-panel" style={width === undefined ? undefined : { width }} aria-label={tr("服务器监控")}>
      <header className="section-heading">
        <span><Activity size={14} />{" "}{tr("实时监控")}</span>
        <div>
          <IconButton title={tr("立即刷新")} onClick={() => setRefresh((v) => v + 1)}><RefreshCw size={14} /></IconButton>
          <IconButton title={paused ? tr("恢复监控") : tr("暂停监控")} active={paused}
            onClick={() => setPaused((v) => !v)}>
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </IconButton>
          {onDetach && <IconButton title={tr("分离监控面板")} onClick={onDetach}><ExternalLink size={14} /></IconButton>}
          {onDock ? <IconButton title={tr("停靠到工作台")} disabled={docking} onClick={onDock}><PanelRight size={14} /></IconButton>
            : <IconButton title={tr("隐藏监控")} onClick={onClose}><X size={14} /></IconButton>}
        </div>
      </header>
      {!remote ? (
        <Empty icon={<Activity size={25} />} title={tr("等待 SSH 连接")}
          text={tr("连接 Linux 服务器后显示实际采集的 CPU、内存、交换、网络、磁盘和进程数据。")} />
      ) : (
        <div className="monitor-body scroll-area">
          <div className="monitor-identity">
            <span className="status-dot connected" />
            <strong title={snapshot?.hostname || remote.name}>{snapshot?.hostname || remote.name}</strong>
            <span className="monitor-identity-protocol"><ShieldCheck size={12} /> SSH</span>
            {lastUpdated && <small>{tr("最近采样")}{" "}{new Date(lastUpdated).toLocaleTimeString(getLocale())}</small>}
          </div>
          {error && <ErrorBox message={error} retry={() => setRefresh((r) => r + 1)} />}
          <div className="monitor-summary-grid">
            <section className="monitor-card">
              <h4><Server size={13} />{" "}{tr("系统信息")}</h4>
              <dl>
                <dt>{tr("系统")}</dt><dd title={snapshot?.os || ""}>{snapshot?.os || tr("正在读取…")}</dd>
                <dt>{tr("内核")}</dt><dd title={snapshot?.kernel || ""}>{snapshot?.kernel || "—"}</dd>
                <dt>CPU</dt><dd>{snapshot?.cpuCores ? snapshot.cpuCores + tr(" 核") : "—"}</dd>
                <dt>{tr("内存")}</dt><dd>{snapshot ? bytes(snapshot.memoryTotal) : "—"}</dd>
              </dl>
            </section>
            <section className="monitor-card">
              <h4><Clock3 size={13} />{" "}{tr("运行状态")}</h4>
              <div className="monitor-uptime">{snapshot ? duration(snapshot.uptime) : "—"}</div>
              <h4 className="monitor-subtitle"><Gauge size={13} />{" "}{tr("负载（1/5/15 分钟）")}</h4>
              <div className="monitor-load">{snapshot ? snapshot.load.map((n) => n.toFixed(2)).join(" / ") : "—"}</div>
            </section>
          </div>
          <div className="monitor-resource-grid">
            <MetricCard icon={<Cpu size={13} />} label="CPU" percent={cpu}
              detail={cpu == null ? tr("等待下次采样") : tr("最近采样区间")} status={cpu != null && cpu >= 90 ? "danger" : "normal"} />
            <MetricCard icon={<MemoryStick size={13} />} label={tr("内存")} percent={mem}
              detail={snapshot ? bytes(snapshot.memoryUsed) + " / " + bytes(snapshot.memoryTotal) : "—"}
              status={mem != null && mem >= 90 ? "danger" : mem != null && mem >= 80 ? "warn" : "normal"} />
            <MetricCard icon={<Layers3 size={13} />} label={tr("交换")} percent={swap}
              detail={snapshot ? snapshot.swapTotal ? bytes(snapshot.swapUsed || 0) + " / " + bytes(snapshot.swapTotal) : tr("未配置 Swap") : "—"}
              status={swap != null && swap >= 85 ? "warn" : "normal"} />
            <MetricCard icon={<HardDrive size={13} />} label={tr("根文件系统")} percent={rootDisk}
              detail={rootMount ? bytes(rootMount.used) + " / " + bytes(rootMount.total) + " · " + (rootMount.fsType || "—") : "—"}
              status={rootDisk != null && rootDisk >= 90 ? "danger" : rootDisk != null && rootDisk >= 80 ? "warn" : "normal"} />
          </div>
          <section className="monitor-card">
            <div className="monitor-card-heading">
              <h4><Gauge size={13} />{" "}{tr("CPU 近期趋势")}</h4>
              <small className="muted">{cpuHistory.length ? cpuHistory.length + tr(" 次采样") : tr("等待采样")}</small>
            </div>
            <MonitorChart kind="cpu" interval={settings.monitorInterval}
              samples={cpuHistory.map((sample) => ({ at: sample.at, values: [sample.value] }))} />
          </section>
          <section className="monitor-card">
            <div className="monitor-card-heading">
              <h4><Network size={13} />{" "}{tr("网络流量")}</h4>
              <select className="monitor-traffic-select" value={selectedInterface}
                onChange={(e) => setSelectedInterface(e.target.value)} aria-label={tr("网卡接口")}>
                <option value="all">{tr("全接口")}</option>
                {(snapshot?.networkInterfaces || []).map((v) =>
                  <option value={v.name} key={v.name}>{v.name}</option>)}
              </select>
            </div>
            <div className="monitor-network-values">
              <span><ArrowDown size={13} className="green" />{" "}{tr("下载")}{" "}<strong>{snapshot && networkHistory.length ? bytes(networkRate.rx) + "/s" : tr("采集中…")}</strong></span>
              <span><ArrowUp size={13} className="accent" />{" "}{tr("上传")}{" "}<strong>{snapshot && networkHistory.length ? bytes(networkRate.tx) + "/s" : tr("采集中…")}</strong></span>
            </div>
            <MonitorChart kind="network" interval={settings.monitorInterval}
              samples={networkHistory.map((sample) => ({ at: sample.at, values: [sample.rx, sample.tx] }))} />
          </section>
          <StorageMonitor snapshot={snapshot} />
          <DiskIoMonitor key={remote.id} snapshot={snapshot} history={diskHistory} interval={settings.monitorInterval} />
          <section className="monitor-card">
            <div className="monitor-card-heading monitor-flex-heading">
              <h4><Cpu size={13} />{" "}{tr("进程")}</h4>
              <button className="text-button" onClick={openProcesses}
                disabled={!snapshot?.processes.length}>{tr("全部进程")}</button>
            </div>
            <div className="monitor-process-order" role="group" aria-label={tr("进程排序")}>
              <button type="button" aria-pressed={processOrder === "cpu"} onClick={() => setProcessOrder("cpu")}>{tr("CPU 排序")}</button>
              <button type="button" aria-pressed={processOrder === "memory"} onClick={() => setProcessOrder("memory")}>{tr("内存排序")}</button>
            </div>
            <div className="monitor-table-scroll scroll-area">
              <MonitorTable tableId="mini-process" columns={miniColumns} className="monitor-process-mini"
                sort={{ key: processOrder, direction: "desc" }} onSort={(key) => { if (key === "cpu" || key === "memory") setProcessOrder(key); }}>
                {topProcesses.map((p) => <tr key={p.pid}>
                  <td>{p.rssBytes == null ? "—" : bytes(p.rssBytes)}</td>
                  <td>{pctText(p.cpu)}</td>
                  <td title={p.command}>{p.command}</td>
                  <td className="monitor-table-filler" aria-hidden="true" />
                </tr>)}
              </MonitorTable>
            </div>
            {!topProcesses.length && <small className="muted">{snapshot?.processes.length && processOrder === "cpu" ? tr("等待下一次有效 CPU 采样") : tr("暂无进程数据")}</small>}
            {snapshot?.processTruncated && <p className="monitor-detail-note warning">{tr("采集受限：已读取 {0} / {1} 个进程", snapshot.processes.length, snapshot.processCount ?? snapshot.processes.length)}</p>}
          </section>
          <footer className="monitor-footer">
            <span className={"status-dot " + (paused ? "" : "connected")} />
            {paused ? tr("采样已暂停") : tr("每 ") + Math.max(2, settings.monitorInterval) + tr(" 秒采样")}
            {sampleDuration != null && <span title={tr("SSH 命令执行和返回的总耗时，不是 ICMP Ping")}>{" "}{tr("· 本次采样")}{" "}{sampleDuration} ms</span>}
          </footer>
        </div>
      )}
      {showProcesses && snapshot && remote && (
        <Modal title={tr("进程 · ") + snapshot.hostname} onClose={() => setShowProcesses(false)} wide>
          <div className="monitor-process-toolbar">
            <input aria-label={tr("搜索进程")} placeholder={tr("搜索 PID、用户或命令…")} value={processQuery}
              onChange={(e) => { setProcessQuery(e.target.value); setProcessPage(0); }} />
            <span>{tr("{0} / {1} 个进程", allProcesses.length, snapshot.processCount ?? snapshot.processes.length)}</span>
          </div>
          {snapshot.processTruncated && <p className="monitor-detail-note warning">{tr("采集受限：已读取 {0} / {1} 个进程", snapshot.processes.length, snapshot.processCount ?? snapshot.processes.length)}</p>}
          <p className="monitor-detail-note">{tr("CPU 为最近采样区间用量，100% 对应一个逻辑核；内存为 RSS，可能包含共享页。")}</p>
          <div className="process-table scroll-area">
            <MonitorTable tableId={detached ? "processes-readonly" : "processes"} columns={detached ? processColumns.slice(0, 5) : processColumns}
              sort={processSort} onSort={changeProcessSort}>
              {allProcesses.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE).map((p) => <tr key={p.pid}>
                <td>{p.pid}</td><td>{p.user}</td><td>{pctText(p.cpu)}</td>
                <td title={pctText(p.memory)}>{p.rssBytes == null ? "—" : bytes(p.rssBytes)}</td>
                <td className="mono truncate" title={p.command}>{p.command}</td>
                {!detached && <td><button className="text-button red" onClick={async () => {
                  if (!remote || !(await confirmAction(
                    tr("向 ") + p.pid + " (" + p.command + tr(") 发送 TERM 信号？"), tr("终止进程")))) return;
                  try {
                    await api("process_signal", { sessionId: remote.id, pid: p.pid, signal: "TERM" });
                    setRefresh((n) => n + 1);
                    notify(tr("TERM 信号已发送。"), "success");
                  } catch (e) { notify(errorText(e), "error"); }
                }}>{tr("终止")}</button></td>}
                <td className="monitor-table-filler" aria-hidden="true" />
              </tr>)}
            </MonitorTable>
          </div>
          {!allProcesses.length && <p className="monitor-detail-note">{tr("没有匹配的进程")}</p>}
          <div className="monitor-process-pagination">
            <button className="button secondary small" disabled={pageIndex === 0} onClick={() => setProcessPage(pageIndex - 1)}>{tr("上一页")}</button>
            <span>{pageIndex + 1} / {pageCount}</span>
            <button className="button secondary small" disabled={pageIndex + 1 >= pageCount} onClick={() => setProcessPage(pageIndex + 1)}>{tr("下一页")}</button>
          </div>
        </Modal>
      )}
    </aside>
  );
}
