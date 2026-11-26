LC_ALL=C; export LC_ALL
if [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then printf '%s\n' 'Linux /proc is required for monitoring' >&2; exit 65; fi
printf '%s\n' __SX_HOST__; hostname
printf '%s\n' __SX_OS__; if [ -r /etc/os-release ]; then sed -n 's/^PRETTY_NAME=//p' /etc/os-release; else uname -s; fi
printf '%s\n' __SX_KERNEL__; uname -r
printf '%s\n' __SX_CORES__; getconf _NPROCESSORS_ONLN 2>/dev/null || printf '0\n'
printf '%s\n' __SX_UPTIME__; cat /proc/uptime
printf '%s\n' __SX_LOAD__; cat /proc/loadavg
printf '%s\n' __SX_CPU__; head -n 1 /proc/stat
printf '%s\n' __SX_MEMORY__; cat /proc/meminfo
printf '%s\n' __SX_NETWORK__; cat /proc/net/dev

# Capacities are distinct from block-device counters; df elides redundant
# bind mounts by default. mountinfo supplies identity and type.
printf '%s\n' __SX_MOUNTINFO__
if [ -r /proc/self/mountinfo ]; then
  awk '{
    for(i=7;i<=NF;i++) if($i=="-"){
      row=$3 " " $4 " " $5 " " $(i+1) " " $(i+2)
      if (NR<=4096 && size+length(row)+1<=128000) {print row; size+=length(row)+1}
      else limited=1
      break
    }
  } END {if(limited) print "__SX_MOUNTINFO_LIMIT__"}' /proc/self/mountinfo
fi
printf '%s\n' __SX_MOUNTS__
# Keep the all-mount view useful, including aliases that df normally suppresses,
# but never let a large mount namespace consume the transport output budget.
{
  if command -v timeout >/dev/null 2>&1; then
    if ! timeout -k 2 6 df -akPT 2>/dev/null; then
      printf '%s\n' __SX_MOUNTS_FALLBACK__
      timeout -k 2 4 df -kPT -l 2>/dev/null || :
    fi
  else
    df -akPT 2>/dev/null || printf '%s\n' __SX_MOUNTS_FALLBACK__
  fi
} | awk '
  /^__SX_MOUNTS_FALLBACK__$/ {print; next}
  size+length($0)+1<=240000 && count<4096 {print; size+=length($0)+1; count++; next}
  {limited=1}
  END {if(limited) print "__SX_MOUNTS_LIMIT__"}
'
printf '%s\n' __SX_IO_TIME__; cat /proc/uptime
printf '%s\n' __SX_BLOCK_DEVICES__
device_count=0
for d in /sys/block/*; do
  [ -d "$d" ] || continue
  n=${d##*/}
  case "$n" in loop*|ram*|zram*|fd[0-9]*|sr[0-9]*) continue;; esac
  [ -r "$d/dev" ] || continue
  device_count=$((device_count+1))
  [ "$device_count" -le 256 ] || break
  printf '%s ' "$n"; cat "$d/dev"
done
printf '%s\n' __SX_DISKSTATS__
if [ -r /proc/diskstats ]; then head -n 4096 /proc/diskstats; fi
printf '%s\n' __SX_CLK_TCK__; getconf CLK_TCK 2>/dev/null || :
printf '%s\n' __SX_PROCESS_TIME__; cat /proc/uptime
printf '%s\n' __SX_PROCESSES__
# All visible processes up to an explicit resource bound. RSS is KiB.
# Read proc stats through awk rather than spawning a command per process.
ps -eo pid=,user:32=,rss=,comm= 2>/dev/null | awk '
  $1 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ {
    count++
    if (count > 10000) next
    pid=$1; user=$2; rss=$3
    command=$0
    sub(/^[[:space:]]*[0-9]+[[:space:]]+[^[:space:]]+[[:space:]]+[0-9]+[[:space:]]+/, "", command)
    path="/proc/" pid "/stat"
    u="-"; s="-"; start="-"
    if ((getline raw < path)>0) {
      sub(/^.*\) /, "", raw)
      n=split(raw, f, " ")
      if (n>=20 && f[12]~/^[0-9]+$/ && f[13]~/^[0-9]+$/ && f[20]~/^[0-9]+$/) {
        u=f[12]; s=f[13]; start=f[20]
      }
    }
    close(path)
    row=pid " " substr(user,1,32) " " rss " " u " " s " " start " " substr(command,1,120)
    if (size+length(row)+1<=1200000) {print row; size+=length(row)+1}
  }
  END { print "__SX_PROCESS_COUNT__"; print count+0 }
'
printf '%s\n' __SX_END__
