export type Host = {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  group: string;
  authMethod: "password" | "key" | "agent" | "interactive";
  /** Missing from older saved hosts means system Keychain. */
  credentialStore?: "local" | "system" | "session";
  privateKeyPath: string | null;
  proxy: { kind: "socks5" | "http"; host: string; port: number } | null;
  jumpHostId: string | null;
  startupDirectory: string | null;
  keepAliveSeconds: number;
  connectTimeoutSeconds: number;
  favorite: boolean;
  color: string;
  notes: string;
};
export type SecretInput = {
  password?: string | null;
  passphrase?: string | null;
};
export type HostKeyInfo = {
  algorithm: string;
  fingerprint: string;
  trusted: boolean;
  changed: boolean;
  previousFingerprint?: string;
};
export type AuthRequest = {
  type: "auth";
  sessionId: string;
  requestId: string;
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
};
export type TerminalEvent =
  | AuthRequest
  | { type: "data"; sessionId: string; data: string; sequence: number }
  | { type: "state"; sessionId: string; state: string; message?: string }
  | { type: "exit"; sessionId: string; code?: number };
export type Session = {
  id: string;
  hostId: string | null;
  name: string;
  local: boolean;
  status: string;
  error?: string;
  terminalFailure?: string;
  connectedAt: number;
};
export type FileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
  uid?: number | null;
  gid?: number | null;
};
export type RemoteFile = {
  path: string;
  text: string;
  version: string;
  size: number;
};
export type Transfer = {
  id: string;
  sessionId: string;
  direction: "upload" | "download";
  localPath: string;
  remotePath: string;
  status: string;
  transferred: number;
  total: number;
  speed: number;
  error?: string;
};
export type ProcessInfo = {
  pid: number;
  user: string;
  cpu: number;
  memory: number;
  command: string;
};
export type MonitorSnapshot = {
  hostname: string;
  os: string;
  kernel?: string;
  cpuCores?: number;
  uptime: number;
  load: [number, number, number];
  cpuPercent: number | null;
  memoryTotal: number;
  memoryUsed: number;
  swapTotal?: number;
  swapUsed?: number;
  diskTotal: number;
  diskUsed: number;
  networkRx: number;
  networkTx: number;
  networkInterfaces?: { name: string; rx: number; tx: number }[];
  diskMounts?: { path: string; total: number; used: number; available: number }[];
  processes: ProcessInfo[];
};
export type DockerContainer = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
};
export type Tunnel = {
  id: string;
  sessionId: string;
  kind: "local" | "remote" | "dynamic";
  bindHost: string;
  bindPort: number;
  targetHost?: string;
  targetPort?: number;
};
export type AppSettings = {
  theme: "graphite" | "mist" | "aurora" | "light" | "dark";
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  monitorInterval: number;
  transferConcurrency: number;
  confirmMultilinePaste: boolean;
  autoReconnect: boolean;
};
export type Workspace = {
  hostIds: string[];
  activeHostId: string | null;
  sidebarWidth: number;
  filesHeight: number;
  monitorVisible: boolean;
  filesVisible: boolean;
  split: "none" | "horizontal" | "vertical";
};
export type Snippet = {
  id: string;
  name: string;
  command: string;
  group: string;
};
export type Notify = (
  message: string,
  kind?: "success" | "error" | "info",
) => void;
export const defaultSettings: AppSettings = {
  theme: "graphite",
  fontSize: 13,
  fontFamily: "Menlo, Monaco, Consolas, monospace",
  scrollback: 10000,
  monitorInterval: 3,
  transferConcurrency: 2,
  confirmMultilinePaste: true,
  autoReconnect: false,
};
export const defaultWorkspace: Workspace = {
  hostIds: [],
  activeHostId: null,
  sidebarWidth: 236,
  filesHeight: 326,
  monitorVisible: true,
  filesVisible: true,
  split: "none",
};
export const newHost = (): Host => ({
  id: crypto.randomUUID(),
  name: "",
  address: "",
  port: 22,
  username: "root",
  group: "默认分组",
  authMethod: "password",
  credentialStore: "local",
  privateKeyPath: null,
  proxy: null,
  jumpHostId: null,
  startupDirectory: null,
  keepAliveSeconds: 30,
  connectTimeoutSeconds: 15,
  favorite: false,
  color: "#69a9f8",
  notes: "",
});
