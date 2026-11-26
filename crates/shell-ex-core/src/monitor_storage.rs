use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskMount {
    pub path: String,
    pub source: String,
    pub fs_type: String,
    pub category: &'static str,
    pub device_id: Option<String>,
    pub duplicate: bool,
    pub total: u64,
    pub used: u64,
    pub available: u64,
}

#[derive(Debug)]
struct MountMeta {
    device: String,
    fs_type: String,
    source: String,
}

fn unescape_mount(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\'
            && i + 3 < bytes.len()
            && bytes[i + 1..i + 4]
                .iter()
                .all(|v| (b'0'..=b'7').contains(v))
        {
            let octal = (bytes[i + 1] - b'0') as u16 * 64
                + (bytes[i + 2] - b'0') as u16 * 8
                + (bytes[i + 3] - b'0') as u16;
            if octal <= 255 {
                out.push(octal as u8);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn category(fs: &str) -> &'static str {
    match fs {
        "ext2" | "ext3" | "ext4" | "xfs" | "btrfs" | "zfs" | "f2fs" | "bcachefs" | "reiserfs"
        | "jfs" | "nilfs2" | "bfs" | "gfs2" | "ocfs2" | "vfat" | "msdos" | "exfat" | "ntfs"
        | "ntfs3" | "fuseblk" | "hfs" | "hfsplus" | "ufs" => "local",
        "nfs" | "nfs3" | "nfs4" | "cifs" | "smb3" | "smbfs" | "ceph" | "glusterfs"
        | "fuse.glusterfs" | "fuse.sshfs" | "9p" | "afs" | "virtiofs" | "fuse.rclone" | "davfs"
        | "fuse.davfs" | "lustre" => "network",
        "overlay" | "aufs" | "fuse.overlayfs" | "fuse-overlayfs" | "tmpfs" | "devtmpfs"
        | "ramfs" | "proc" | "sysfs" | "cgroup" | "cgroup2" | "devpts" | "securityfs"
        | "debugfs" | "tracefs" | "configfs" | "squashfs" | "nsfs" | "mqueue" | "hugetlbfs"
        | "pstore" | "autofs" | "bpf" | "binfmt_misc" | "fusectl" | "rootfs" => "virtual",
        _ => "other",
    }
}

pub fn parse_mounts(df: &str, fallback: &str, metadata: &str) -> Vec<DiskMount> {
    let mut meta = HashMap::new();
    for line in metadata.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() != 5 {
            continue;
        }
        meta.insert(
            unescape_mount(fields[2]),
            MountMeta {
                device: fields[0].to_owned(),
                fs_type: fields[3].to_owned(),
                source: unescape_mount(fields[4]),
            },
        );
    }
    let mut mounts = Vec::new();
    let mut seen_paths = HashSet::new();
    for line in df.lines().chain(fallback.lines()) {
        let f: Vec<_> = line.split_whitespace().collect();
        let Some(i) = (4..f.len().saturating_sub(1)).find(|&i| {
            f[i].strip_suffix('%')
                .is_some_and(|v| v.parse::<u64>().is_ok())
                && f[i - 3..i - 1].iter().all(|v| v.parse::<u64>().is_ok())
                && (f[i - 1].parse::<u64>().is_ok() || f[i - 1].parse::<i64>().is_ok())
        }) else {
            continue;
        };
        let path_at = f[i + 1].as_ptr() as usize - line.as_ptr() as usize;
        let type_at = f[i - 4].as_ptr() as usize - line.as_ptr() as usize;
        let path = line[path_at..].to_owned();
        if !path.starts_with('/') || !seen_paths.insert(path.clone()) {
            continue;
        }
        let m = meta.get(&path);
        let fs_type = m
            .map(|v| v.fs_type.clone())
            .unwrap_or_else(|| f[i - 4].to_owned());
        let source = m
            .map(|v| v.source.clone())
            .unwrap_or_else(|| line[..type_at].trim().to_owned());
        let kind = if source.starts_with("/dev/loop")
            || source.starts_with("/dev/ram")
            || source.starts_with("/dev/zram")
        {
            "virtual"
        } else {
            category(&fs_type)
        };
        let kib = |value: &str| value.parse::<u64>().unwrap_or(0).saturating_mul(1024);
        mounts.push(DiskMount {
            path,
            source,
            fs_type,
            category: kind,
            device_id: m.map(|v| v.device.clone()),
            duplicate: false,
            total: kib(f[i - 3]),
            used: kib(f[i - 2]),
            available: kib(f[i - 1]),
        });
    }
    mounts.sort_by(|a, b| {
        (a.path != "/", a.path.len(), &a.path).cmp(&(b.path != "/", b.path.len(), &b.path))
    });
    let mut seen = HashSet::new();
    for m in &mut mounts {
        let key = match m.category {
            "local" if matches!(m.fs_type.as_str(), "btrfs" | "zfs") => {
                format!("{}:{}", m.fs_type, m.source)
            }
            "local" => match &m.device_id {
                Some(id) if !id.starts_with("0:") => format!("block:{}", id),
                _ => format!("{}:{}", m.fs_type, m.source),
            },
            "network" => format!("{}:{}", m.fs_type, m.source),
            _ => continue,
        };
        m.duplicate = !seen.insert(key);
    }
    mounts
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct DiskCounters {
    reads: u64,
    read_sectors: u64,
    read_ms: u64,
    writes: u64,
    write_sectors: u64,
    write_ms: u64,
    busy_ms: u64,
    weighted_ms: u64,
}
#[derive(Debug, Clone)]
pub struct DiskSample {
    pub name: String,
    pub device_id: String,
    pub counters: DiskCounters,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskIo {
    pub name: String,
    pub device_id: String,
    pub layer: &'static str,
    pub read_bytes_per_sec: Option<f64>,
    pub write_bytes_per_sec: Option<f64>,
    pub read_iops: Option<f64>,
    pub write_iops: Option<f64>,
    pub utilization: Option<f64>,
    pub await_ms: Option<f64>,
    pub read_await_ms: Option<f64>,
    pub write_await_ms: Option<f64>,
    pub queue_depth: Option<f64>,
}
pub fn parse_diskstats(devices: &str, data: &str) -> Vec<DiskSample> {
    let ids: HashMap<_, _> = devices
        .lines()
        .filter_map(|line| {
            let mut f = line.split_whitespace();
            Some((f.next()?, f.next()?))
        })
        .collect();
    let mut result = Vec::new();
    for line in data.lines() {
        let f: Vec<_> = line.split_whitespace().collect();
        if f.len() < 14 {
            continue;
        }
        let id = format!("{}:{}", f[0], f[1]);
        if ids.get(f[2]).copied() != Some(id.as_str()) {
            continue;
        }
        let values: Option<Vec<u64>> = f[3..14].iter().map(|v| v.parse().ok()).collect();
        let Some(v) = values else {
            continue;
        };
        result.push(DiskSample {
            name: f[2].to_owned(),
            device_id: id,
            counters: DiskCounters {
                reads: v[0],
                read_sectors: v[2],
                read_ms: v[3],
                writes: v[4],
                write_sectors: v[6],
                write_ms: v[7],
                busy_ms: v[9],
                weighted_ms: v[10],
            },
        });
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    result
}

pub fn disk_rate(
    sample: &DiskSample,
    previous: Option<&DiskSample>,
    elapsed: Option<f64>,
) -> DiskIo {
    let mut result = DiskIo {
        name: sample.name.clone(),
        device_id: sample.device_id.clone(),
        layer: if sample.name.starts_with("dm-")
            || sample.name.starts_with("md")
            || sample.name.starts_with("bcache")
        {
            "logical"
        } else {
            "device"
        },
        read_bytes_per_sec: None,
        write_bytes_per_sec: None,
        read_iops: None,
        write_iops: None,
        utilization: None,
        await_ms: None,
        read_await_ms: None,
        write_await_ms: None,
        queue_depth: None,
    };
    let Some(seconds) = elapsed.filter(|v| v.is_finite() && *v > 0.0) else {
        return result;
    };
    let Some(old) = previous.filter(|v| v.device_id == sample.device_id && v.name == sample.name)
    else {
        return result;
    };
    let n = &sample.counters;
    let p = &old.counters;
    let deltas: Option<Vec<u64>> = [
        (n.reads, p.reads),
        (n.read_sectors, p.read_sectors),
        (n.read_ms, p.read_ms),
        (n.writes, p.writes),
        (n.write_sectors, p.write_sectors),
        (n.write_ms, p.write_ms),
        (n.busy_ms, p.busy_ms),
        (n.weighted_ms, p.weighted_ms),
    ]
    .into_iter()
    .map(|(a, b)| a.checked_sub(b))
    .collect();
    let Some(d) = deltas else {
        return result;
    };
    let (r, rs, rt, w, ws, wt, busy, weighted) = (
        d[0] as f64,
        d[1] as f64,
        d[2] as f64,
        d[3] as f64,
        d[4] as f64,
        d[5] as f64,
        d[6] as f64,
        d[7] as f64,
    );
    result.read_bytes_per_sec = Some(rs * 512.0 / seconds);
    result.write_bytes_per_sec = Some(ws * 512.0 / seconds);
    result.read_iops = Some(r / seconds);
    result.write_iops = Some(w / seconds);
    result.utilization = Some((busy / (seconds * 10.0)).clamp(0.0, 100.0));
    result.queue_depth = Some(weighted / (seconds * 1000.0));
    result.read_await_ms = (r > 0.0).then(|| rt / r);
    result.write_await_ms = (w > 0.0).then(|| wt / w);
    result.await_ms = (r + w > 0.0).then(|| (rt + wt) / (r + w));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_and_deduplicates_without_counting_overlay_as_storage() {
        let df = "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 ext4 100 30 70 30% /\n/dev/vda1 ext4 100 30 70 30% /bind\n/dev/vdb1 xfs 200 20 180 10% /data with spaces\noverlay overlay 100 30 70 30% /container\ntmpfs tmpfs 50 0 50 0% /run\nserver:/export nfs4 400 20 380 5% /nas\n/dev/loop0 ext4 20 10 10 50% /image";
        let metadata = "8:1 / / ext4 /dev/vda1\n8:1 /sub /bind ext4 /dev/vda1\n8:17 / /data\\040with\\040spaces xfs /dev/vdb1";
        let rows = parse_mounts(df, "", metadata);
        assert_eq!(rows.len(), 7);
        let find = |path: &str| rows.iter().find(|m| m.path == path).unwrap();
        assert_eq!(find("/").category, "local");
        assert!(!find("/").duplicate);
        assert!(find("/bind").duplicate);
        assert_eq!(find("/data with spaces").total, 200 * 1024);
        assert_eq!(find("/nas").category, "network");
        assert_eq!(find("/container").category, "virtual");
        assert_eq!(find("/run").category, "virtual");
        assert_eq!(find("/image").category, "virtual");
    }
    #[test]
    fn whole_device_deltas_have_correct_units_and_handle_reset() {
        let devices = "vda 252:0\ndm-0 253:0";
        let first = parse_diskstats(
            devices,
            "252 0 vda 10 0 100 20 20 0 200 40 0 50 60\n252 1 vda1 1 0 2 3 4 0 5 6 0 7 8",
        );
        let second = parse_diskstats(devices, "252 0 vda 14 0 120 28 22 0 240 46 0 550 1060");
        assert_eq!(first.len(), 1);
        let m = disk_rate(&second[0], Some(&first[0]), Some(2.0));
        assert_eq!(m.read_bytes_per_sec, Some(5120.0));
        assert_eq!(m.write_bytes_per_sec, Some(10240.0));
        assert_eq!(m.read_iops, Some(2.0));
        assert_eq!(m.write_iops, Some(1.0));
        assert_eq!(m.utilization, Some(25.0));
        assert_eq!(m.queue_depth, Some(0.5));
        assert_eq!(m.read_await_ms, Some(2.0));
        assert_eq!(m.write_await_ms, Some(3.0));
        assert_eq!(
            disk_rate(&first[0], Some(&second[0]), Some(2.0)).utilization,
            None
        );
        assert_eq!(
            disk_rate(&first[0], None, Some(2.0)).read_bytes_per_sec,
            None
        );
    }
}
