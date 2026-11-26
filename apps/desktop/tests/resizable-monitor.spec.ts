import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ locale: "zh-CN" });

async function drag(page: Page, handle: Locator, delta: number) {
  await handle.scrollIntoViewIfNeeded();
  const r = await handle.boundingBox();
  if (!r) throw new Error("Resize handle missing");
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + delta, r.y + r.height / 2, { steps: 8 });
  await page.mouse.up();
}

test("dock, directory tree and individual columns resize and persist", async ({ page }) => {
  // The fixture provides an isolated local browser IPC stub, not a live server.
  await page.addInitScript(() => {
    const makeHost = (id: string, name: string) => ({
      id, name, address: "192.0.2.10", port: 22, username: "test", group: "Fixture",
      authMethod: "password", credentialStore: "builtin", privateKeyPath: null,
      proxy: null, jumpHostId: null, startupDirectory: null, keepAliveSeconds: 30,
      connectTimeoutSeconds: 15, favorite: false, color: "#69a9f8", notes: "",
    });
    const hosts = [
      makeHost("bc6f7e3e-e59b-4c7f-b485-1f3782ed3240", "Fixture A"),
      makeHost("bc6f7e3e-e59b-4c7f-b485-1f3782ed3241", "Fixture B"),
    ];
    let callback = 0, monitorOpen = false;
    let context: unknown = null;
    const monitor = {
      hostname: "Fixture telemetry", os: "Linux fixture", kernel: "6.1",
      cpuCores: 4, uptime: 120, load: [0.1, 0.2, 0.3], cpuPercent: 12,
      memoryTotal: 8192, memoryUsed: 2048, swapTotal: 0, swapUsed: 0,
      diskTotal: 16384, diskUsed: 8192, networkRx: 100, networkTx: 200,
      networkInterfaces: [], diskMounts: [], processes: [],
    };
    const entries = [{
      name: "example.log", path: "/app/example.log", isDir: false,
      isSymlink: false, size: 1024, modified: null, permissions: 0o100644, uid: 1000, gid: 1000,
    }];
    Object.defineProperty(window, "isTauri", { value: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => ++callback,
      unregisterCallback: () => {},
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        switch (cmd) {
          case "hosts_list": return hosts;
          case "settings_get": return {};
          case "workspace_get": return JSON.parse(localStorage.getItem("fixture-workspace") || "{}");
          case "workspace_save": localStorage.setItem("fixture-workspace", JSON.stringify(args.workspace)); return args.workspace;
          case "monitor_window_is_open": return monitorOpen;
          case "monitor_window_open": monitorOpen = true; context = args.context; return null;
          case "monitor_window_update": context = args.context; return null;
          case "monitor_window_dock": monitorOpen = false; return null;
          case "ssh_probe": return { trusted: true, changed: false, algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture" };
          case "host_secret_status": return true;
          case "ssh_connect": return { sessionId: "session-" + args.hostId, credentialSaveFailed: false };
          case "sftp_realpath": return args.path === "." ? "/app" : args.path;
          case "sftp_list": return args.path === "/"
            ? [{ ...entries[0], name: "app", path: "/app", isDir: true, permissions: 0o40755 }]
            : entries;
          case "monitor_snapshot": return monitor;
          case "plugin:event|listen": return ++callback;
          case "transfers_list": case "tunnels_list": return [];
          default: return null;
        }
      },
    }});
    Object.defineProperty(window, "__fixtureMonitor", { value: {
      getContext: () => context,
      close: () => { monitorOpen = false; },
    }});
  });
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  const first = page.locator(".host-item").filter({ hasText: "Fixture A" }).first();
  await first.locator(".host-main").dblclick();
  await expect(page.locator(".file-list tbody")).toContainText("example.log");
  const monitor = page.locator(".workspace-main > .monitor-panel");
  const monitorHandle = page.getByRole("separator", { name: "调整监控面板宽度", exact: true });
  const monitorInitial = (await monitor.boundingBox())!.width;
  await drag(page, monitorHandle, -90);
  await expect.poll(async () => Math.round((await monitor.boundingBox())!.width)).toBe(Math.round(monitorInitial + 90));
  const tree = page.locator(".directory-tree");
  const treeInitial = (await tree.boundingBox())!.width;
  await drag(page, page.getByRole("separator", { name: "调整目录树宽度", exact: true }), 60);
  await expect.poll(async () => Math.round((await tree.boundingBox())!.width)).toBe(Math.round(treeInitial + 60));
  const name = page.locator(".resizable-file-heading").first();
  const size = page.locator(".resizable-file-heading").nth(1);
  const nameInitial = (await name.boundingBox())!.width;
  const sizeInitial = (await size.boundingBox())!.width;
  const nameHandle = page.getByRole("separator", { name: "调整列宽：文件名", exact: true });
  await page.evaluate(() => {
    Element.prototype.setPointerCapture = () => { throw new Error("Pointer capture unavailable"); };
  });
  expect((await nameHandle.boundingBox())!.width).toBeGreaterThanOrEqual(12);
  await expect(nameHandle).toHaveCSS("cursor", "col-resize");

  await drag(page, nameHandle, 100);
  await expect.poll(async () => Math.round((await name.boundingBox())!.width)).toBe(Math.round(nameInitial + 100));
  expect(Math.abs((await size.boundingBox())!.width - sizeInitial)).toBeLessThanOrEqual(1);
  await expect.poll(async () => page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem("fixture-workspace") || "{}");
    return [w.monitorWidth, w.fileTreeWidth, w.fileColumnWidths?.[0]];
  })).toEqual([455, 270, Math.round(nameInitial + 100)]);

  await monitor.getByRole("button", { name: "分离监控面板", exact: true }).click();
  await expect(monitor).toHaveCount(0);
  await expect(page.getByRole("button", { name: "停靠监控面板", exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => (window as any).__fixtureMonitor.getContext()?.session?.name)).toBe("Fixture A");
  await page.locator(".host-item").filter({ hasText: "Fixture B" }).first().locator(".host-main").dblclick();
  await expect.poll(async () => page.evaluate(() => (window as any).__fixtureMonitor.getContext()?.session?.name)).toBe("Fixture B");
  await page.evaluate(() => (window as any).__fixtureMonitor.close());
  await expect(monitor).toBeVisible();
  await expect.poll(async () => Math.round((await monitor.boundingBox())!.width)).toBe(455);
  await page.reload();
  await expect(monitor).toBeVisible();
  await expect.poll(async () => Math.round((await monitor.boundingBox())!.width)).toBe(455);
  await first.locator(".host-main").dblclick();
  await expect(page.locator(".file-list tbody")).toContainText("example.log");
  await expect.poll(async () => Math.round((await tree.boundingBox())!.width)).toBe(270);
  await expect.poll(async () => Math.round((await name.boundingBox())!.width)).toBe(Math.round(nameInitial + 100));
  await nameHandle.dblclick();
  await expect.poll(async () => Math.round((await name.boundingBox())!.width)).toBe(280);
});

test("detached webview mounts only read-only monitoring and can return to dock", async ({ page }) => {
  await page.addInitScript(() => {
    const initial = { session: { id: "fixture", name: "Fixture" }, theme: "black", monitorInterval: 3, language: "zh-CN" };
    let context: typeof initial | null = initial;
    let docked = false, samples = 0;
    Object.defineProperty(window, "isTauri", { value: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
      metadata: { currentWindow: { label: "monitor" }, currentWebview: { label: "monitor", windowLabel: "monitor" } },
      transformCallback: () => 1,
      invoke: async (cmd: string) => {
        if (cmd === "monitor_window_context") return context;
        if (cmd === "monitor_window_snapshot") {
          samples++;
          return {
          hostname: "Fixture host", os: "Linux", kernel: "6.1", cpuCores: 4,
          uptime: 120, load: [0.1, 0.2, 0.3], cpuPercent: 12, memoryTotal: 8192,
          memoryUsed: 2048, swapTotal: 0, swapUsed: 0, diskTotal: 16384,
          diskUsed: 8192, networkRx: samples * 4096, networkTx: samples * 2048, networkInterfaces: [],
          diskMounts: [{ path: "/data/example/long/mount/path", source: "/dev/vda1", fsType: "xfs", category: "local", duplicate: false, total: 16384, used: 8192, available: 8192 }],
          processes: [{ pid: 42, user: "test", cpu: 1, memory: 1, rssBytes: 1024, command: "fixture" }],
        };
        }
        if (cmd === "monitor_window_dock") { docked = true; context = null; return null; }
        throw new Error("Unexpected command " + cmd);
      },
    }});
    Object.defineProperty(window, "__fixture", { value: {
      docked: () => docked,
      english: () => { context = { ...initial, theme: "mist", language: "en" }; },
      gray: () => { context = { ...initial, theme: "gray", language: "en" }; },
      softWhite: () => { context = { ...initial, theme: "soft-white", language: "en" }; },
      reopen: () => { context = initial; docked = false; },
      samples: () => samples,
    }});
  });
  await page.setViewportSize({ width: 560, height: 760 });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveCount(0);
  const panel = page.locator(".detached-monitor-window .monitor-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Fixture host");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "black");
  const cpu = panel.locator('[data-chart="cpu"]');
  await expect(cpu.locator(".monitor-chart-y > span")).toHaveText(["100%", "75%", "50%", "25%", "0%"]);
  await expect(cpu.locator(".monitor-chart-x > span")).toHaveCount(3);
  await panel.getByRole("button", { name: "立即刷新", exact: true }).click();
  const network = panel.locator('[data-chart="network"]');
  await expect(network.locator(".monitor-chart-unit")).toHaveText(/^(B|KB|MB|GB|TB)\/s$/);
  await expect(network.locator(".monitor-chart-y > span")).toHaveCount(5);
  await expect(network.locator(".monitor-chart-x > span")).toHaveCount(3);
  const mini = panel.locator('[data-monitor-table="mini-process"]');
  const mounts = panel.locator('[data-monitor-table="mounts"]');
  for (const [table, label, initialWidth] of [
    [mini, "内存", 80], [mounts, "路径", 105],
  ] as const) {
    const handle = table.getByRole("separator", { name: "调整列宽：" + label, exact: true });
    const columns = table.locator(".resizable-monitor-heading");
    const before = (await columns.nth(1).boundingBox())!.width;
    await drag(page, handle, 55);
    await expect.poll(async () => Math.round((await columns.first().boundingBox())!.width)).toBe(initialWidth + 55);
    expect(Math.abs((await columns.nth(1).boundingBox())!.width - before)).toBeLessThanOrEqual(1);
  }
  await panel.getByRole("button", { name: "全部进程", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("fixture");
  await expect(page.getByRole("button", { name: "终止", exact: true })).toHaveCount(0);
  const processes = page.getByRole("dialog").locator('[data-monitor-table="processes-readonly"]');
  await expect(processes.getByRole("separator")).toHaveCount(5);
  const pid = processes.getByRole("separator", { name: "调整列宽：PID", exact: true });
  await drag(page, pid, 30);
  await expect(pid).toHaveAttribute("aria-valuenow", "95");
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as any).__fixture.english());
  await expect(page.locator("html")).toHaveAttribute("data-theme", "mist");
  await page.evaluate(() => (window as any).__fixture.gray());
  await expect(page.locator("html")).toHaveAttribute("data-theme", "gray");
  await expect(panel).toHaveCSS("background-color", "rgb(73, 73, 73)");
  await page.evaluate(() => (window as any).__fixture.softWhite());
  await expect(page.locator("html")).toHaveAttribute("data-theme", "soft-white");
  await expect(panel).toHaveCSS("background-color", "rgb(224, 226, 219)");
  await panel.getByRole("button", { name: "Dock to workspace", exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__fixture.docked())).toBe(true);
  await expect(panel.locator('[data-chart="cpu"]')).toHaveCount(0);
  // Reuse the same webview without recreating it, and repeat docking.
  await page.evaluate(() => (window as any).__fixture.reopen());
  await expect(panel).toContainText("Fixture host");
  await expect(panel.locator('[data-monitor-table="mini-process"] .resizable-monitor-heading').first()).toHaveCSS("width", "135px");
  await expect(panel.locator('[data-monitor-table="mounts"] .resizable-monitor-heading').first()).toHaveCSS("width", "160px");
  await panel.getByRole("button", { name: "停靠到工作台", exact: true }).click();
  await expect(panel.locator('[data-chart="cpu"]')).toHaveCount(0);
});
