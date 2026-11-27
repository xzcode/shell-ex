# Shell EX

**English** | [简体中文](README.zh-CN.md)

A cross-platform SSH desktop workbench for managing servers, terminals, remote files, transfers and system monitoring in one window.

Built with **Tauri 2 · Rust / Tokio · React / TypeScript · xterm.js · Monaco**.

## Download

Install the [latest stable release](https://github.com/xzcode/shell-ex/releases/latest). Shell EX does not require an account or a dedicated server.

| Platform | Installer |
| --- | --- |
| macOS (Apple Silicon) | `.dmg` |
| Windows (x64) | `.exe` (NSIS) |
| Linux (x64) | `.deb` |

The release page includes SHA-256 checksums and build provenance for each installer. See [all releases](https://github.com/xzcode/shell-ex/releases) and the [v0.4.18 release notes](docs/releases/v0.4.18.md). macOS builds use ad-hoc signing, not Apple notarization; Windows builds may display an unrecognized-publisher warning. The Linux package targets compatible Debian-based systems.

## Preview

![Shell EX graphite workbench](docs/design/images/workbench-v0.2-graphite.png)

Historical v0.2.0 browser preview (disconnected, using TEST-NET example hosts). See the [light theme preview](docs/design/images/workbench-v0.2-mist.png) and [UI design notes](docs/design/UI.md). Current versions include seven themes and additional monitoring and workspace features. Live SSH/SFTP and Linux metrics require the desktop app and an actual connection.

## Features

| Area | Capabilities |
| --- | --- |
| Host management | Table-based connection manager overlay, sorting, adjustable columns, multiple independent sessions per connection, custom groups (including empty groups), favorites, search, duplicate/edit connections, SSH config import preview and encrypted migration |
| Terminal | SSH password, private key, SSH agent and interactive authentication; local PTY; multiple tabs, horizontal/vertical splits, search, reconnect, fonts, themes and background image; terminal context menu |
| Remote files | Bottom docked dual-pane SFTP browser, lazy directory tree, sortable/resizable columns, file metadata, multi-selection, creation, rename, permissions and drag-and-drop upload, explicit sudo file mode (passwordless or password-authorized), elevated archive downloads |
| Transfers | Upload/download, directory planning, overwrite policies, bounded concurrency, progress, pause/resume/cancel and SHA-256 verification |
| Editor | Monaco, UTF-8 text, syntax highlighting, find/replace, conflict detection, atomic replacement and Save As |
| Monitoring | Full-height left-side dockable/detachable Linux monitor; CPU, memory, swap, load, kernel, network throughput, unique local/shared filesystems, disk throughput, IOPS, utilization, latency, queue depth; sortable/searchable process list and CPU/RSS rankings |
| Networking | SOCKS5, HTTP CONNECT, jump hosts, local/remote/dynamic SSH forwarding |
| Operations | Compact quick commands; Docker containers, images, logs, start/stop/restart; explicit process signal actions in the main workspace |
| Customization | Seven themes including Neutral Gray and Soft White; persistent layouts and column widths; multilingual interface |
| Local data | SQLite connection settings, built-in AES-256-GCM credential storage by default without a master password, legacy vault compatibility, encrypted backups and workspace restoration |

No product login, dedicated backend or monitoring agent is required. Configuration is stored locally; the app does not include telemetry or automatic configuration uploads. The default local credential store is designed for convenience, not protection against an attacker with access to your device and application files.

## Getting started

1. Create a connection with the host, port, username and authentication method.
2. Connect and verify the server's SHA-256 host key fingerprint before trusting it. Changed fingerprints are never accepted automatically.
3. Choose local encrypted password storage (default) or enter the password each time. Legacy connections retain their storage method.
4. Open the terminal and use the bottom panel for files, transfers, quick commands, tunnels and Docker. Open the Linux monitor for server metrics.

SSH private key paths are stored as references. SSH agent authentication uses the current user's agent via `SSH_AUTH_SOCK` on macOS/Linux or the OpenSSH Agent named pipe on Windows. Jump hosts connect before the target. Reconnection creates a new remote shell; use a server-side tool such as `tmux` to keep remote tasks alive independently of the connection.

## Development

Requirements: Node.js 22+, a compatible Rust toolchain, and [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). macOS requires Xcode Command Line Tools; Windows requires the MSVC C++ toolchain and WebView2; Linux requires GTK 3 and WebKitGTK 4.1 development packages.

```bash
git clone https://github.com/xzcode/shell-ex.git
cd shell-ex/apps/desktop
npm ci
npm run tauri dev
```

Run `npm run dev` for the browser-only UI preview. It allows editing preview hosts and settings, but cannot open SSH/local terminals or perform file operations and does not store passwords.

### Build installers

```bash
# macOS Apple Silicon, from the repository root
cd apps/desktop
rustup target add aarch64-apple-darwin
npm run tauri -- build --target aarch64-apple-darwin --bundles app,dmg
```

Use `--bundles nsis` on Windows and `--bundles deb` on Linux. The [Desktop packages workflow](https://github.com/xzcode/shell-ex/actions/workflows/desktop.yml) builds all three supported targets. Version changes or explicitly requested publication can produce formal releases after the required assets are verified; ordinary development builds remain drafts. See [release documentation](docs/RELEASE.md) for historical build records and signing/update details.

### Verification

```bash
# From the repository root: core and authentication tests
cargo test --locked -p shell-ex-core --lib --test auth_protocol

# Temporary loopback OpenSSH fixture; no personal servers are used
python3 scripts/ssh_fixture.py cargo test --locked -p shell-ex-core \
  --test ssh_integration --test files_integration -- --ignored --test-threads=1

# Frontend type checking and production build
cd apps/desktop
npm run build
```

CI, browser regression tests, native packaging and physical-device checks are distinct forms of verification. See [Actions](https://github.com/xzcode/shell-ex/actions) and the version-specific release notes.

## Known limitations

- The editor handles UTF-8 text up to 5 MiB. Download non-text files instead. Atomic replacement requires the server's OpenSSH `posix-rename` extension; traditional permissions and UID/GID are preserved, but ACLs/xattrs are not copied.
- Transfers can resume within the same running application, not automatically after restart. Directory copies are limited to 1,000 files per operation and skip symbolic links with a report.
- SSH config import supports a defined subset; it does not execute `Include`, `Match`, `ProxyCommand` or local commands. Unsupported routes are not silently converted to direct connections.
- The file panel does not elevate privileges automatically. Its opt-in sudo mode respects existing authorization for an OpenSSH `sftp-server` executable, trying passwordless sudo first and offering password entry if denied. Elevated `.tar.gz` packing additionally requires authorization for `/usr/bin/tar`. Passwords are not persisted; they are retained in zeroizing backend memory only for the active file capability. Leaving the mode cancels unfinished privileged transfers and attempts staging cleanup. Abrupt disconnects can leave private staging files. MFA, `requiretty`, and unsupported custom authentication prompts are not supported. No sudoers settings are changed.
- Linux monitoring depends on available procfs/sysfs and system utilities. The process list is bounded to 10,000 entries and a transport byte budget. Network filesystem capacity is shown, but NFS-specific I/O is not collected. Initial/missing disk samples are not fabricated. The detached monitor is read-only.
- Native macOS docking/re-docking and certain clipboard/file picker interactions still require real-device validation.
- Empty-group metadata and terminal wallpaper are local preferences not included in the older portable backup format. Signed auto-updates require a configured trusted public key and HTTPS endpoint and are disabled by default.

## Documentation

- [Product requirements](docs/product/PRD.md) · [UI design](docs/design/UI.md) · [Architecture](docs/architecture/ARCHITECTURE.md)
- [Security and data](docs/SECURITY.md) · [Release and updates](docs/RELEASE.md) · [Development handoff](docs/HANDOFF.md)
- [Milestone status](docs/milestones/STATUS.md) · [Release notes](docs/releases/) · [GitHub Releases](https://github.com/xzcode/shell-ex/releases)

Some internal documents are currently available in Chinese only.

## License

See [LICENSE](LICENSE) for application code terms and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party licenses.
