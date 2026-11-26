//! Linux agentless telemetry. No user supplied text is interpolated into the
//! collection command. CPU is computed from counter deltas per SSH session.
use crate::{
    error::{AppError, Result},
    ssh::SshManager,
};
use serde::Serialize;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;

use crate::monitor_storage::{disk_rate, parse_diskstats, parse_mounts, DiskSample};
pub use crate::monitor_storage::{DiskIo, DiskMount};
const COLLECT: &str = include_str!("monitor_collect.sh");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub user: String,
    pub cpu: Option<f64>,
    pub memory: Option<f64>,
    pub rss_bytes: u64,
    pub command: String,
}
#[derive(Debug, Clone)]
struct ProcessCounter {
    start: u64,
    ticks: u64,
}
#[derive(Default)]
struct Counters {
    cpu: (u64, u64),
    uptime: f64,
    io_time: Option<f64>,
    disks: Vec<DiskSample>,
    process_time: Option<f64>,
    clock_ticks: Option<u64>,
    processes: HashMap<u32, ProcessCounter>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterface {
    pub name: String,
    pub rx: u64,
    pub tx: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub cpu_cores: u32,
    pub uptime: f64,
    pub load: [f64; 3],
    pub cpu_percent: Option<f64>,
    pub memory_total: u64,
    pub memory_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub disk_total: u64,
    pub disk_used: u64,
    pub network_rx: u64,
    pub network_tx: u64,
    pub network_interfaces: Vec<NetworkInterface>,
    pub disk_mounts: Vec<DiskMount>,
    pub storage_partial: bool,
    pub disk_io: Vec<DiskIo>,
    pub process_count: usize,
    pub process_truncated: bool,
    pub processes: Vec<ProcessInfo>,
}

pub struct MonitorService {
    ssh: Arc<SshManager>,
    previous: Mutex<HashMap<String, Counters>>,
}
impl MonitorService {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self {
            ssh,
            previous: Mutex::new(HashMap::new()),
        }
    }
    pub async fn snapshot(&self, session_id: &str) -> Result<MonitorSnapshot> {
        let output = self.ssh.exec(session_id, COLLECT).await?;
        if output.status != 0 {
            return Err(AppError::new(
                "MONITOR_UNAVAILABLE",
                format!("Linux telemetry unavailable: {}", output.stderr.trim()),
            ));
        }
        let (mut snapshot, counters) = parse_snapshot(&output.stdout)?;
        let mut previous = self.previous.lock().await;
        // Reject out-of-order samples across docking and manual refresh.
        let old = previous.get(session_id);
        let ordered = old.is_none_or(|p| counters.uptime > p.uptime);
        let comparable = old.filter(|_| ordered);
        apply_deltas(&mut snapshot, &counters, comparable);
        if ordered || old.is_some_and(|p| counters.uptime + 30.0 < p.uptime) {
            previous.insert(session_id.into(), counters);
        }
        Ok(snapshot)
    }
    pub async fn forget_session(&self, session_id: &str) {
        self.previous.lock().await.remove(session_id);
    }
    pub async fn process_signal(&self, session_id: &str, pid: u32, signal: &str) -> Result<()> {
        if pid < 2 {
            return Err(AppError::new(
                "PROTECTED_PROCESS",
                "PID 0 and PID 1 cannot be signalled through the process panel",
            ));
        }
        if signal != "TERM" && signal != "KILL" {
            return Err(AppError::new(
                "INVALID_SIGNAL",
                "Only TERM and KILL are supported",
            ));
        }
        // Numeric PID and a closed signal enum; no shell fragments can enter.
        let result = self
            .ssh
            .exec(session_id, &format!("kill -{signal} {pid}"))
            .await?;
        if result.status != 0 {
            return Err(AppError::new("PROCESS_SIGNAL_FAILED", result.stderr.trim()));
        }
        Ok(())
    }
}

fn section<'a>(text: &'a str, name: &str) -> Result<&'a str> {
    let marker = format!("__SX_{name}__");
    let mut offset = 0;
    let mut start = None;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if let Some(begin) = start {
            if trimmed.starts_with("__SX_") && trimmed.ends_with("__") {
                return Ok(text[begin..offset].trim_end());
            }
        } else if trimmed == marker {
            start = Some(offset + line.len());
        }
        offset += line.len();
    }
    start
        .map(|begin| text[begin..].trim_end())
        .ok_or_else(|| AppError::new("MONITOR_PARSE_ERROR", format!("Missing {name} section")))
}
fn optional_time(text: &str, name: &str) -> Option<f64> {
    section(text, name)
        .ok()?
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.0)
}
fn parse_snapshot(text: &str) -> Result<(MonitorSnapshot, Counters)> {
    let parse_num = |value: Option<&str>| -> f64 {
        value
            .and_then(|n| n.parse::<f64>().ok())
            .filter(|n| n.is_finite())
            .unwrap_or(0.0)
    };
    let hostname = section(text, "HOST")?
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    let os = section(text, "OS")?.trim_matches('"').to_string();
    let kernel = section(text, "KERNEL").ok().unwrap_or("—").to_string();
    let cpu_cores = section(text, "CORES")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);
    let uptime = parse_num(section(text, "UPTIME")?.split_whitespace().next());
    let mut load_items = section(text, "LOAD")?.split_whitespace();
    let load = [
        parse_num(load_items.next()),
        parse_num(load_items.next()),
        parse_num(load_items.next()),
    ];
    // guest and guest_nice are already included in user/nice; exclude them.
    let cpu: Vec<u64> = section(text, "CPU")?
        .split_whitespace()
        .skip(1)
        .take(8)
        .map(|v| v.parse().unwrap_or(0))
        .collect();
    if cpu.len() < 4 {
        return Err(AppError::new("MONITOR_PARSE_ERROR", "Missing CPU counters"));
    }
    let total = cpu.iter().copied().sum();
    let idle = cpu.get(3).copied().unwrap_or(0) + cpu.get(4).copied().unwrap_or(0);
    let memory: HashMap<&str, u64> = section(text, "MEMORY")?
        .lines()
        .filter_map(|line| {
            let (key, rest) = line.split_once(':')?;
            let value = rest.split_whitespace().next()?.parse::<u64>().ok()?;
            Some((key, value.saturating_mul(1024)))
        })
        .collect();
    let memory_total = *memory
        .get("MemTotal")
        .ok_or_else(|| AppError::new("MONITOR_PARSE_ERROR", "Missing total memory"))?;
    let available = memory.get("MemAvailable").copied().unwrap_or_else(|| {
        memory.get("MemFree").unwrap_or(&0)
            + memory.get("Buffers").unwrap_or(&0)
            + memory.get("Cached").unwrap_or(&0)
    });
    let memory_used = memory_total.saturating_sub(available);
    let swap_total = memory.get("SwapTotal").copied().unwrap_or(0);
    let swap_used =
        swap_total.saturating_sub(memory.get("SwapFree").copied().unwrap_or(swap_total));
    let mut network_interfaces = Vec::new();
    let mut network_rx = 0u64;
    let mut network_tx = 0u64;
    for line in section(text, "NETWORK")?.lines() {
        let Some((name, stats)) = line.split_once(':') else {
            continue;
        };
        if name.trim() == "lo" {
            continue;
        }
        let fields: Vec<_> = stats.split_whitespace().collect();
        let rx = fields
            .first()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let tx = fields
            .get(8)
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        network_rx = network_rx.saturating_add(rx);
        network_tx = network_tx.saturating_add(tx);
        if network_interfaces.len() < 32 {
            network_interfaces.push(NetworkInterface {
                name: name.trim().to_string(),
                rx,
                tx,
            });
        }
    }
    let disk_mounts = parse_mounts(
        section(text, "MOUNTS").unwrap_or(""),
        section(text, "MOUNTS_FALLBACK").unwrap_or(""),
        section(text, "MOUNTINFO").unwrap_or(""),
    );
    let root = disk_mounts.iter().find(|m| m.path == "/");
    let (disk_total, disk_used) = root.map(|m| (m.total, m.used)).unwrap_or((0, 0));
    let storage_partial = ["MOUNTS_FALLBACK", "MOUNTS_LIMIT", "MOUNTINFO_LIMIT"]
        .iter()
        .any(|name| section(text, name).is_ok());
    let disks = parse_diskstats(
        section(text, "BLOCK_DEVICES").unwrap_or(""),
        section(text, "DISKSTATS").unwrap_or(""),
    );
    let mut process_counters = HashMap::new();
    let processes: Vec<_> = section(text, "PROCESSES")?
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid: u32 = fields.next()?.parse().ok()?;
            let user = fields.next()?.to_owned();
            let rss_bytes = fields.next()?.parse::<u64>().ok()?.saturating_mul(1024);
            let u = fields.next()?.parse::<u64>().ok();
            let s = fields.next()?.parse::<u64>().ok();
            let start = fields.next()?.parse::<u64>().ok();
            if let (Some(u), Some(s), Some(start)) = (u, s, start) {
                if let Some(ticks) = u.checked_add(s) {
                    process_counters.insert(pid, ProcessCounter { start, ticks });
                }
            }
            let command = fields.collect::<Vec<_>>().join(" ");
            Some(ProcessInfo {
                pid,
                user,
                cpu: None,
                memory: (memory_total > 0).then(|| rss_bytes as f64 * 100.0 / memory_total as f64),
                rss_bytes,
                command,
            })
        })
        .collect();
    let process_count = section(text, "PROCESS_COUNT")
        .ok()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(processes.len())
        .max(processes.len());
    let process_truncated = process_count > processes.len();
    Ok((
        MonitorSnapshot {
            hostname,
            os,
            kernel,
            cpu_cores,
            uptime,
            load,
            cpu_percent: None,
            memory_total,
            memory_used,
            swap_total,
            swap_used,
            disk_total,
            disk_used,
            network_rx,
            network_tx,
            network_interfaces,
            disk_mounts,
            storage_partial,
            disk_io: Vec::new(),
            process_count,
            process_truncated,
            processes,
        },
        Counters {
            cpu: (total, idle),
            uptime,
            io_time: optional_time(text, "IO_TIME"),
            disks,
            process_time: optional_time(text, "PROCESS_TIME"),
            clock_ticks: section(text, "CLK_TCK")
                .ok()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .filter(|v| *v > 0),
            processes: process_counters,
        },
    ))
}

fn elapsed(now: Option<f64>, old: Option<f64>) -> Option<f64> {
    Some(now? - old?).filter(|v| v.is_finite() && *v > 0.0)
}

fn apply_deltas(snapshot: &mut MonitorSnapshot, current: &Counters, previous: Option<&Counters>) {
    if let Some(old) = previous {
        if let (Some(total), Some(idle)) = (
            current.cpu.0.checked_sub(old.cpu.0),
            current.cpu.1.checked_sub(old.cpu.1),
        ) {
            if total > 0 {
                snapshot.cpu_percent =
                    Some(100.0 * (total - idle.min(total)) as f64 / total as f64);
            }
        }
        if let (Some(seconds), Some(hz)) = (
            elapsed(current.process_time, old.process_time),
            current.clock_ticks.filter(|v| Some(*v) == old.clock_ticks),
        ) {
            for p in &mut snapshot.processes {
                if let (Some(n), Some(b)) =
                    (current.processes.get(&p.pid), old.processes.get(&p.pid))
                {
                    if n.start == b.start {
                        p.cpu = n
                            .ticks
                            .checked_sub(b.ticks)
                            .map(|v| v as f64 * 100.0 / hz as f64 / seconds);
                    }
                }
            }
        }
    }
    let seconds = previous.and_then(|old| elapsed(current.io_time, old.io_time));
    let old_disks: HashMap<_, _> = previous
        .into_iter()
        .flat_map(|p| p.disks.iter())
        .map(|d| (d.device_id.as_str(), d))
        .collect();
    snapshot.disk_io = current
        .disks
        .iter()
        .map(|d| disk_rate(d, old_disks.get(d.device_id.as_str()).copied(), seconds))
        .collect();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linux_snapshot_has_correct_units_and_no_guest_double_count() {
        let raw="__SX_HOST__\ndev\n__SX_OS__\n\"Test Linux\"\n__SX_UPTIME__\n100.5 200\n__SX_LOAD__\n1.0 2.0 3.0 1/10 100\n__SX_CPU__\ncpu 10 2 3 40 5 1 1 0 3 1\n__SX_MEMORY__\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n__SX_NETWORK__\nlo: 99 0 0 0 0 0 0 0 99 0 0 0 0 0 0 0\neth0: 123 0 0 0 0 0 0 0 456 0 0 0 0 0 0 0\n__SX_MOUNTS__\n/dev/test ext4 100 60 40 60% /\n__SX_PROCESSES__\n42 root 12 10 2 500 server\n__SX_END__\n";
        let (value, cpu) = parse_snapshot(raw).unwrap();
        assert_eq!(cpu.cpu, (62, 45));
        assert_eq!(value.memory_used, 600 * 1024);
        assert_eq!(value.network_rx, 123);
        assert_eq!(value.network_tx, 456);
        assert_eq!(value.network_interfaces[0].name, "eth0");
        assert_eq!(value.network_interfaces[0].tx, 456);
        assert_eq!(value.swap_total, 0);
        assert_eq!(value.disk_total, 100 * 1024);
        assert_eq!(value.processes[0].pid, 42);
        assert_eq!(value.cpu_percent, None);
    }
    #[test]
    fn extra_linux_telemetry_is_parsed_when_available() {
        let raw = "__SX_HOST__\ndev\n__SX_OS__\nLinux\n__SX_KERNEL__\n6.6.0\n__SX_CORES__\n8\n__SX_UPTIME__\n101 200\n__SX_LOAD__\n1 2 3\n__SX_CPU__\ncpu 10 2 3 40 5 1 1 0\n__SX_MEMORY__\nMemTotal: 2000 kB\nMemAvailable: 1000 kB\nSwapTotal: 1000 kB\nSwapFree: 400 kB\n__SX_NETWORK__\nlo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\neth0: 123 0 0 0 0 0 0 0 456 0 0 0 0 0 0 0\n__SX_MOUNTS__\nFilesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/a ext4 100 70 30 70% /\ntmpfs tmpfs 300 10 290 3% /run\n__SX_PROCESSES__\n42 root 20 10 2 500 test\n__SX_END__\n";
        let (value, _) = parse_snapshot(raw).unwrap();
        assert_eq!(value.kernel, "6.6.0");
        assert_eq!(value.cpu_cores, 8);
        assert_eq!(value.swap_total, 1000 * 1024);
        assert_eq!(value.swap_used, 600 * 1024);
        assert_eq!(value.disk_mounts.len(), 2);
        assert_eq!(value.disk_mounts[1].available, 290 * 1024);
    }
    #[test]
    fn process_cpu_uses_interval_ticks_and_rejects_pid_reuse() {
        let raw = "__SX_HOST__\ndev\n__SX_OS__\nLinux\n__SX_UPTIME__\n100 0\n__SX_LOAD__\n0 0 0\n__SX_CPU__\ncpu 1 2 3 4\n__SX_MEMORY__\nMemTotal: 2000 kB\nMemAvailable: 1000 kB\n__SX_NETWORK__\n__SX_CLK_TCK__\n100\n__SX_PROCESS_TIME__\n100 0\n__SX_PROCESSES__\n42 user 200 10 10 5 java\n43 user 300 10 10 6 other\n__SX_PROCESS_COUNT__\n3\n__SX_END__\n";
        let (_, old) = parse_snapshot(raw).unwrap();
        let new = raw
            .replace("100 0", "102 0")
            .replace("42 user 200 10 10 5", "42 user 400 210 110 5")
            .replace("43 user 300 10 10 6", "43 user 300 210 110 7");
        let (mut value, current) = parse_snapshot(&new).unwrap();
        apply_deltas(&mut value, &current, Some(&old));
        assert_eq!(value.processes[0].cpu, Some(150.0));
        assert_eq!(value.processes[0].rss_bytes, 400 * 1024);
        assert_eq!(value.processes[1].cpu, None);
        assert!(value.process_truncated);
    }
    #[test]
    fn invalid_output_is_not_fabricated_metrics() {
        assert!(parse_snapshot("not Linux").is_err());
    }
}
