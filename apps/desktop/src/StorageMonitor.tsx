import { useState } from "react";
import { Activity, HardDrive, ArrowDown, ArrowUp } from "lucide-react";
import { tr } from "./i18n";
import { bytes } from "./api";
import { MonitorTable } from "./MonitorTable";
import { MonitorChart } from "./MonitorChart";
import type { MonitorSnapshot } from "./types";
import { diskKey, filterMounts, useMonitorPreference, type DiskHistory, type StorageFilter } from "./monitorModel";

const storageFilters = ["storage", "local", "network", "all"] as const;
const labels: Record<StorageFilter, string> = { storage: "全部存储", local: "本地文件系统", network: "网络 / 共享", all: "全部已采集挂载点" };
const mountColumns = [
  { label: "路径", width: 105, min: 70 },
  { label: "可用 / 总量", width: 120, min: 95 },
  { label: "已用", width: 95, min: 75 },
  { label: "文件系统", width: 86, min: 66 },
];

export function StorageMonitor({ snapshot }: { snapshot: MonitorSnapshot | null }) {
  const [filter, setFilter] = useMonitorPreference<StorageFilter>("storage-filter-v1", storageFilters, "storage");
  const all = snapshot?.diskMounts || [];
  const mounts = filterMounts(all, filter);
  const hidden = all.length - filterMounts(all, "storage").length;
  return <section className="monitor-card storage-monitor">
    <div className="monitor-card-heading monitor-flex-heading">
      <h4><HardDrive size={13} />{" "}{tr("存储空间")}</h4>
      <select className="monitor-traffic-select" aria-label={tr("存储类型")} value={filter}
        onChange={(e) => setFilter(e.target.value as StorageFilter)}>
        {storageFilters.map((id) => <option key={id} value={id}>{tr(labels[id])}</option>)}
      </select>
    </div>
    <div className="monitor-mount-table scroll-area">
      <MonitorTable tableId="mounts" columns={mountColumns}>
        {mounts.map((mount) => {
          // Use the same denominator as df's capacity percentage (reserved blocks
          // are not treated as available to ordinary users).
          const usable = mount.used + mount.available;
          const pct = usable > 0 ? Math.min(100, mount.used / usable * 100) : null;
          return <tr key={mount.path} data-storage-category={mount.category}>
            <td title={mount.path + "\n" + (mount.source || "")}>
              <div className="monitor-mount-path">{mount.path}</div>
              <small className="monitor-mount-source">{mount.source || "—"}</small>
            </td>
            <td title={tr("可用 / 总量")}>{bytes(mount.available)} / {bytes(mount.total)}</td>
            <td><div className="monitor-mount-usage"><span>{pct == null ? "—" : Math.ceil(pct) + "%"}</span>
              <div className="monitor-bar"><span className={"monitor-bar-fill " + ((pct ?? 0) >= 90 ? "danger" : (pct ?? 0) >= 80 ? "warn" : "normal")}
                style={{ width: (pct ?? 0) + "%" }} /></div></div></td>
            <td title={tr(mount.category === "network" ? "网络 / 共享" : mount.category === "local" ? "本地文件系统" : mount.category === "virtual" ? "虚拟文件系统" : "其他文件系统")}>
              <div>{mount.fsType || "—"}</div>
              {mount.duplicate && <small className="monitor-mount-source">{tr("重复挂载")}</small>}
            </td>
            <td className="monitor-table-filler" aria-hidden="true" />
          </tr>;
        })}
      </MonitorTable>
    </div>
    {!mounts.length && <p className="monitor-detail-note">{snapshot ? tr("没有符合条件的存储空间") : tr("等待采样")}</p>}
    {hidden > 0 && filter !== "all" && <p className="monitor-detail-note">{tr("已隐藏 {0} 个虚拟、其他或重复挂载", hidden)}</p>}
    {snapshot?.storagePartial && <p className="monitor-detail-note warning">{tr("部分挂载信息采集失败或超出限制，列表可能不完整。")}</p>}
    <p className="monitor-detail-note">{tr("文件系统容量，不是独立物理磁盘数量；共享存储容量不累加。")}</p>
  </section>;
}

const amount = (value: number | null | undefined, suffix = "", digits = 1) =>
  value != null && Number.isFinite(value) ? value.toFixed(digits) + suffix : "—";
const rate = (value: number | null | undefined) => value == null ? "—" : bytes(value) + "/s";

export function DiskIoMonitor({ snapshot, history, interval }: {
  snapshot: MonitorSnapshot | null; history: DiskHistory; interval: number;
}) {
  const [selected, setSelected] = useState("");
  const devices = snapshot?.diskIo || [];
  const disk = devices.find((item) => diskKey(item) === selected) || devices.find((item) => item.layer === "device") || devices[0];
  const key = disk ? diskKey(disk) : "";
  const samples = history[key] || [];
  return <section className="monitor-card disk-io-monitor">
    <div className="monitor-card-heading monitor-flex-heading">
      <h4><Activity size={13} />{" "}{tr("磁盘 I/O")}</h4>
      {devices.length > 0 && <select className="monitor-traffic-select" aria-label={tr("磁盘设备")}
        value={key} onChange={(e) => setSelected(e.target.value)}>
        {devices.map((d) => <option key={diskKey(d)} value={diskKey(d)}>{d.name}{d.layer === "logical" ? " · " + tr("逻辑设备") : ""}</option>)}
      </select>}
    </div>
    {!disk ? <p className="monitor-detail-note">{snapshot ? tr("当前环境没有可用的块设备 I/O 数据") : tr("等待采样")}</p> : <>
      <div className="monitor-network-values">
        <span><ArrowDown size={13} className="green" />{tr("读取")} <strong data-io-value="read">{rate(disk.readBytesPerSec)}</strong></span>
        <span><ArrowUp size={13} className="accent" />{tr("写入")} <strong data-io-value="write">{rate(disk.writeBytesPerSec)}</strong></span>
      </div>
      <MonitorChart kind="disk" interval={interval} samples={samples.map((s) => ({ at: s.at, values: [s.read, s.write] }))} />
      <div className="monitor-card-heading monitor-busy-heading"><h4>{tr("设备忙碌率")}</h4><strong data-io-value="util">{amount(disk.utilization, "%")}</strong></div>
      <MonitorChart kind="disk-util" interval={interval} samples={samples.map((s) => ({ at: s.at, values: [s.busy] }))} />
      <dl className="monitor-io-details">
        <dt>{tr("读取 IOPS")}</dt><dd>{amount(disk.readIops, "/s")}</dd>
        <dt>{tr("写入 IOPS")}</dt><dd>{amount(disk.writeIops, "/s")}</dd>
        <dt>{tr("平均 I/O 延迟")}</dt><dd>{amount(disk.awaitMs, " ms", 2)}</dd>
        <dt>{tr("读取延迟")}</dt><dd>{amount(disk.readAwaitMs, " ms", 2)}</dd>
        <dt>{tr("写入延迟")}</dt><dd>{amount(disk.writeAwaitMs, " ms", 2)}</dd>
        <dt>{tr("平均队列长度")}</dt><dd>{amount(disk.queueDepth, "", 2)}</dd>
      </dl>
      {disk.utilization == null && <p className="monitor-detail-note">{tr("等待下一次有效采样计算 I/O")}</p>}
      <p className="monitor-detail-note">{tr("按设备独立统计；逻辑设备与底层设备不可累加。忙碌率不代表 SSD / RAID 性能上限。")}</p>
    </>}
  </section>;
}
