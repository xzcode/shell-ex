//! Linux agentless telemetry. No user supplied text is interpolated into the
//! collection command. CPU is computed from counter deltas per SSH session.
use crate::{
    error::{AppError, Result},
    ssh::SshManager,
};
use serde::Serialize;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;

const COLLECT: &str = r#"LC_ALL=C; export LC_ALL
if [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then printf '%s\n' 'Linux /proc is required for monitoring' >&2; exit 65; fi
printf '%s\n' __SX_HOST__; hostname
printf '%s\n' __SX_OS__; if [ -r /etc/os-release ]; then sed -n 's/^PRETTY_NAME=//p' /etc/os-release; else uname -s; fi
printf '%s\n' __SX_UPTIME__; cat /proc/uptime
printf '%s\n' __SX_LOAD__; cat /proc/loadavg
printf '%s\n' __SX_CPU__; head -n 1 /proc/stat
printf '%s\n' __SX_MEMORY__; cat /proc/meminfo
printf '%s\n' __SX_NETWORK__; cat /proc/net/dev
printf '%s\n' __SX_DISK__; df -Pk / | tail -n 1
printf '%s\n' __SX_PROCESSES__; ps -eo pid=,user=,pcpu=,pmem=,comm= --sort=-pcpu 2>/dev/null | head -n 60
printf '%s\n' __SX_END__
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub user: String,
    pub cpu: f64,
    pub memory: f64,
    pub command: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub hostname: String,
    pub os: String,
    pub uptime: f64,
    pub load: [f64; 3],
    pub cpu_percent: Option<f64>,
    pub memory_total: u64,
    pub memory_used: u64,
    pub disk_total: u64,
    pub disk_used: u64,
    pub network_rx: u64,
    pub network_tx: u64,
    pub processes: Vec<ProcessInfo>,
}

pub struct MonitorService {
    ssh: Arc<SshManager>,
    previous: Mutex<HashMap<String, (u64, u64)>>,
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
        if let Some((total, idle)) = previous.insert(session_id.into(), counters) {
            if counters.0 >= total && counters.1 >= idle && counters.0 > total {
                let all = counters.0 - total;
                let inactive = (counters.1 - idle).min(all);
                snapshot.cpu_percent = Some(100.0 * (all - inactive) as f64 / all as f64);
            }
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
    let marker = format!("__SX_{name}__\n");
    let start = text
        .find(&marker)
        .ok_or_else(|| AppError::new("MONITOR_PARSE_ERROR", format!("Missing {name} section")))?
        + marker.len();
    let rest = &text[start..];
    let end = rest.find("\n__SX_").unwrap_or(rest.len());
    Ok(rest[..end].trim())
}
fn parse_snapshot(text: &str) -> Result<(MonitorSnapshot, (u64, u64))> {
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
        network_rx = network_rx.saturating_add(
            fields
                .first()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0),
        );
        network_tx = network_tx.saturating_add(
            fields
                .get(8)
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0),
        );
    }
    let disk_fields: Vec<_> = section(text, "DISK")?.split_whitespace().collect();
    let disk_total = disk_fields
        .get(1)
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0)
        .saturating_mul(1024);
    let disk_used = disk_fields
        .get(2)
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0)
        .saturating_mul(1024);
    let processes = section(text, "PROCESSES")?
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let user = fields.next()?.to_owned();
            let cpu = parse_num(fields.next());
            let memory = parse_num(fields.next());
            let command = fields.collect::<Vec<_>>().join(" ");
            Some(ProcessInfo {
                pid,
                user,
                cpu,
                memory,
                command,
            })
        })
        .collect();
    Ok((
        MonitorSnapshot {
            hostname,
            os,
            uptime,
            load,
            cpu_percent: None,
            memory_total,
            memory_used,
            disk_total,
            disk_used,
            network_rx,
            network_tx,
            processes,
        },
        (total, idle),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linux_snapshot_has_correct_units_and_no_guest_double_count() {
        let raw="__SX_HOST__\ndev\n__SX_OS__\n\"Test Linux\"\n__SX_UPTIME__\n100.5 200\n__SX_LOAD__\n1.0 2.0 3.0 1/10 100\n__SX_CPU__\ncpu 10 2 3 40 5 1 1 0 3 1\n__SX_MEMORY__\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n__SX_NETWORK__\nlo: 99 0 0 0 0 0 0 0 99 0 0 0 0 0 0 0\neth0: 123 0 0 0 0 0 0 0 456 0 0 0 0 0 0 0\n__SX_DISK__\n/dev/test 100 60 40 60% /\n__SX_PROCESSES__\n42 root 2.3 1.2 server\n__SX_END__\n";
        let (value, cpu) = parse_snapshot(raw).unwrap();
        assert_eq!(cpu, (62, 45));
        assert_eq!(value.memory_used, 600 * 1024);
        assert_eq!(value.network_rx, 123);
        assert_eq!(value.network_tx, 456);
        assert_eq!(value.disk_total, 100 * 1024);
        assert_eq!(value.processes[0].pid, 42);
        assert_eq!(value.cpu_percent, None);
    }
    #[test]
    fn invalid_output_is_not_fabricated_metrics() {
        assert!(parse_snapshot("not Linux").is_err());
    }
}
