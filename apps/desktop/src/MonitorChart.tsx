import { getLocale, tr } from "./i18n";

type Sample = { at: number; values: number[] };
type Series = { color: string; label: string };
const colors = { cpu: "var(--accent)", rx: "var(--green)", tx: "var(--amber)" };

function networkScale(samples: Sample[]) {
  const peak = Math.max(1, ...samples.flatMap((sample) => sample.values.filter(Number.isFinite)));
  const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(peak) / Math.log(1024)));
  const divisor = 1024 ** unit;
  const raw = peak / divisor / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((n) => n * power >= raw) || 10) * power;
  const top = Math.max(step * 4, 1 / divisor);
  return { max: top * divisor, unit: units[unit], divisor };
}

export function MonitorChart({ kind, samples, interval }: {
  kind: "cpu" | "network" | "disk" | "disk-util"; samples: Sample[]; interval: number;
}) {
  const network = kind === "network" || kind === "disk";
  const scale = network ? networkScale(samples) : { max: 100, unit: "%", divisor: 1 };
  const series: Series[] = network
    ? [{ color: colors.rx, label: tr(kind === "disk" ? "读取" : "下载") }, { color: colors.tx, label: tr(kind === "disk" ? "写入" : "上传") }]
    : [{ color: colors.cpu, label: kind === "disk-util" ? tr("设备忙碌率") : "CPU" }];
  const last = samples.at(-1)?.at ?? 0;
  const first = samples[0]?.at ?? 0;
  const start = first < last ? first : last - Math.max(2, interval) * 1000;
  const span = Math.max(1, last - start);
  const number = new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 2 });
  const time = new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const ticks = [1, 0.75, 0.5, 0.25, 0];
  const x = (sample: Sample) => Math.max(0, Math.min(300, (sample.at - start) / span * 300));
  const y = (value: number) => 100 - Math.max(0, Math.min(1, value / scale.max)) * 100;
  return <div className="monitor-chart" data-chart={kind}
    role="img" aria-label={tr(kind === "disk" ? "磁盘读写趋势" : kind === "disk-util" ? "磁盘忙碌率趋势" : kind === "network" ? "最近网络吞吐量趋势" : "最近 CPU 使用率趋势")}>
    <div className="monitor-chart-y" aria-label={tr("纵轴刻度")}>
      {ticks.map((fraction) => <span key={fraction}>{number.format(scale.max * fraction / scale.divisor)}{network ? "" : "%"}</span>)}
    </div>
    <div className="monitor-chart-plot">
      <svg viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true">
        {ticks.map((fraction) => <line key={fraction} x1="0" x2="300" y1={100 - fraction * 100} y2={100 - fraction * 100} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        {[0, 150, 300].map((pos) => <line key={pos} x1={pos} x2={pos} y1="0" y2="100" stroke="var(--border-soft)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />)}
        {series.map((item, i) => <g key={i}>
          <polyline points={samples.map((sample) => x(sample).toFixed(2) + "," + y(sample.values[i]).toFixed(2)).join(" ")}
            fill="none" stroke={item.color} strokeWidth="1.7" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </g>)}
      </svg>
      {samples.length === 1 && series.map((item, i) => <span key={i} className="monitor-chart-dot"
        style={{ left: x(samples[0]) / 3 + "%", top: y(samples[0].values[i]) + "%", background: item.color }} />)}
      {!samples.length && <span className="monitor-chart-empty">{tr("等待采样")}</span>}
    </div>
    <div className="monitor-chart-unit">{network ? scale.unit : ""}</div>
    <div className="monitor-chart-x" aria-label={tr("时间轴")}>
      {samples.length ? [start, start + span / 2, last].map((at, i) => <span key={i}>{time.format(at)}</span>) : <span>—</span>}
    </div>
  </div>;
}
