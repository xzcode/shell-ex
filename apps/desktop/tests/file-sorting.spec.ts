import { expect, test } from "@playwright/test";
import { defaultFileSort, nextFileSort, parseFileSort, sortFileEntries, FILE_SORT_STORAGE_KEY, type FileSortKey } from "../src/fileSort";
import type { FileEntry } from "../src/types";
import { fileTableWidth, fitFileColumnWidths, resizeFileColumnWidths } from "../src/fileColumnLayout";

function item(name: string, size: number, modified: number | null, extra: Partial<FileEntry> = {}): FileEntry {
  return { name, path: "/app/" + name, isDir: false, isSymlink: false, size, modified, permissions: 0o100644, uid: 1000, gid: 1000, ...extra };
}
const entries = [
  item("file10.txt", 1024 * 1024, 100, { uid: 10, gid: 20, permissions: 0o100600 }),
  item("dir10", 4096, 500, { isDir: true, permissions: 0o40755, uid: 0, gid: 0 }),
  item("link", 5, null, { isSymlink: true, permissions: null, uid: null, gid: null }),
  item("file2.txt", 2048, 300, { uid: 2, gid: 20, permissions: 0o100644 }),
  item("dir2", 4096, 400, { isDir: true, permissions: 0o40700, uid: 0, gid: 0 }),
  item(".hidden", 100, 200, { uid: 2, gid: 10, permissions: 0o100640 }),
];

test("sorts raw file metadata, preserves input, and keeps unavailable values last", () => {
  const ordered = (column: FileSortKey, direction: "asc" | "desc") =>
    sortFileEntries(entries, { column, direction }, "en").map((e) => e.name);
  expect(ordered("name", "asc")).toEqual(["dir2", "dir10", ".hidden", "file2.txt", "file10.txt", "link"]);
  expect(ordered("name", "desc")).toEqual(["dir10", "dir2", "link", "file10.txt", "file2.txt", ".hidden"]);
  expect(ordered("size", "asc")).toEqual(["link", ".hidden", "file2.txt", "file10.txt", "dir2", "dir10"]);
  expect(ordered("size", "desc")).toEqual(["file10.txt", "file2.txt", ".hidden", "link", "dir2", "dir10"]);
  expect(ordered("modified", "asc")).toEqual(["file10.txt", ".hidden", "file2.txt", "dir2", "dir10", "link"]);
  expect(ordered("modified", "desc")).toEqual(["dir10", "dir2", "file2.txt", ".hidden", "file10.txt", "link"]);
  expect(ordered("type", "asc")).toEqual(["dir2", "dir10", ".hidden", "file2.txt", "file10.txt", "link"]);
  expect(ordered("type", "desc")).toEqual(["link", ".hidden", "file2.txt", "file10.txt", "dir2", "dir10"]);
  expect(ordered("permissions", "asc")).toEqual(["file10.txt", ".hidden", "file2.txt", "dir2", "dir10", "link"]);
  expect(ordered("owner", "asc")).toEqual(["dir2", "dir10", ".hidden", "file2.txt", "file10.txt", "link"]);
  expect(ordered("owner", "desc")).toEqual(["file10.txt", "file2.txt", ".hidden", "dir2", "dir10", "link"]);
  expect(entries[0].name).toBe("file10.txt");
  expect(parseFileSort('{"column":"modified","direction":"desc"}')).toEqual({ column: "modified", direction: "desc" });
  expect(parseFileSort('{"column":"bad","direction":"desc"}')).toEqual(defaultFileSort);
  expect(parseFileSort("corrupt")).toEqual(defaultFileSort);
  expect(nextFileSort(defaultFileSort, "name")).toEqual({ column: "name", direction: "desc" });
  expect(nextFileSort({ column: "name", direction: "desc" }, "size")).toEqual({ column: "size", direction: "asc" });
});

test("file columns fill wide panes, keep explicit resize widths and overflow on narrow panes", () => {
  const preferred = [280, 100, 92, 160, 132, 116];
  expect(fitFileColumnWidths(preferred, 600)).toEqual(preferred);
  const wide = fitFileColumnWidths(preferred, 1800);
  expect(fileTableWidth(wide)).toBe(1800);
  expect(wide.every((width, i) => width > preferred[i])).toBe(true);
  expect(preferred).toEqual([280, 100, 92, 160, 132, 116]);
  for (const index of [0, 5]) {
    const grown = resizeFileColumnWidths(wide, index, wide[index] + 40, 1800);
    expect(grown[index]).toBe(wide[index] + 40);
    expect(grown.filter((_, i) => i !== index)).toEqual(wide.filter((_, i) => i !== index));
    expect(fileTableWidth(grown)).toBe(1840);
    const shrunk = resizeFileColumnWidths(wide, index, wide[index] - 40, 1800);
    expect(shrunk[index]).toBe(wide[index] - 40);
    expect(fileTableWidth(shrunk)).toBe(1800);
  }
});

test("file headers toggle sorting independently of resizing and preserve selected paths", async ({ page }) => {
  // Browser fixture only: no connection to a real SSH server.
  await page.addInitScript((files) => {
    let callback = 0, listCalls = 0;
    const host = {
      id: "bc6f7e3e-e59b-4c7f-b485-1f3782ed3240", name: "Sorting fixture",
      address: "192.0.2.10", port: 22, username: "test", group: "Fixture",
      authMethod: "password", credentialStore: "builtin", privateKeyPath: null,
      proxy: null, jumpHostId: null, startupDirectory: null, keepAliveSeconds: 30,
      connectTimeoutSeconds: 15, favorite: false, color: "#69a9f8", notes: "",
    };
    Object.defineProperty(window, "isTauri", { value: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => ++callback,
      unregisterCallback: () => {},
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        switch (cmd) {
          case "hosts_list": return [host];
          case "settings_get": return {};
          case "workspace_get": return {};
          case "workspace_save": return args.workspace;
          case "monitor_window_is_open": return false;
          case "ssh_probe": return { trusted: true, changed: false, algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture" };
          case "host_secret_status": return true;
          case "ssh_connect": return { sessionId: "session-" + args.hostId, credentialSaveFailed: false };
          case "sftp_realpath": return args.path === "." ? "/app" : args.path;
          case "sftp_list": {
            if (args.path === "/") return [{ ...files[1], name: "app", path: "/app" }];
            if (args.path === "/app") { listCalls++; return files; }
            return [];
          }
          case "monitor_snapshot": return {
            hostname: "Fixture", os: "Linux", kernel: "6.1", cpuCores: 4, uptime: 120,
            load: [0.1, 0.2, 0.3], cpuPercent: 12, memoryTotal: 8192, memoryUsed: 2048,
            swapTotal: 0, swapUsed: 0, diskTotal: 16384, diskUsed: 8192,
            networkRx: 100, networkTx: 200, networkInterfaces: [], diskMounts: [], processes: [],
          };
          case "plugin:event|listen": return ++callback;
          case "transfers_list": case "tunnels_list": case "snippets_list": return [];
          default: return null;
        }
      },
    }});
    Object.defineProperty(window, "__fileListCalls", { value: () => listCalls });
  }, entries);
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  const host = page.locator(".host-item").filter({ hasText: "Sorting fixture" }).first();
  await page.getByRole("button", { name: "连接管理", exact: true }).click();
  await host.locator(".manager-host-name").dblclick();
  const table = page.locator(".resizable-file-table");
  const rows = table.locator("tbody .file-name-content > span");
  const headers = table.locator(".resizable-file-heading");
  const sort = (label: string) => table.getByRole("button", { name: "按 " + label + " 排序", exact: true });
  await expect(rows).toHaveText(["dir2", "dir10", ".hidden", "file2.txt", "file10.txt", "link"]);
  await expect(headers.first()).toHaveAttribute("aria-sort", "ascending");
  const calls = await page.evaluate(() => (window as any).__fileListCalls());
  await table.getByRole("checkbox", { name: "选择 file2.txt", exact: true }).check();
  await sort("大小").click();
  await expect(rows).toHaveText(["link", ".hidden", "file2.txt", "file10.txt", "dir2", "dir10"]);
  await expect(headers.nth(1)).toHaveAttribute("aria-sort", "ascending");
  await sort("大小").click();
  await expect(rows).toHaveText(["file10.txt", "file2.txt", ".hidden", "link", "dir2", "dir10"]);
  await expect(headers.nth(1)).toHaveAttribute("aria-sort", "descending");
  await expect(table.getByRole("checkbox", { name: "选择 file2.txt", exact: true })).toBeChecked();
  await sort("修改时间").click();
  await expect(rows).toHaveText(["file10.txt", ".hidden", "file2.txt", "dir2", "dir10", "link"]);
  await sort("修改时间").click();
  await expect(rows).toHaveText(["dir10", "dir2", "file2.txt", ".hidden", "file10.txt", "link"]);
  await sort("类型").click();
  await expect(rows).toHaveText(["dir2", "dir10", ".hidden", "file2.txt", "file10.txt", "link"]);
  await sort("类型").click();
  await expect(rows.first()).toHaveText("link");
  // A maximized window must fill the visible SFTP list, without a blank strip.
  const list = page.locator(".file-list");
  const layout = () => list.evaluate(el => {
    const table = el.querySelector("table")!;
    const row = table.querySelector("tbody tr")!;
    return { client: el.clientWidth, scroll: el.scrollWidth, table: table.offsetWidth,
      row: Math.round(row.getBoundingClientRect().width) };
  });
  await page.setViewportSize({ width: 2400, height: 920 });
  await expect.poll(async () => {
    const geometry = await layout();
    return Math.abs(geometry.table - geometry.client) <= 1
      && Math.abs(geometry.row - geometry.client) <= 1
      && geometry.scroll <= geometry.client + 1;
  }).toBe(true);
  // The right edge remains a resize-only target.
  const grip = table.getByRole("separator", { name: "调整列宽：文件名", exact: true });
  await grip.scrollIntoViewIfNeeded();
  const box = (await grip.boundingBox())!;
  const width = (await headers.first().boundingBox())!.width;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await headers.first().boundingBox())!.width)).toBe(Math.round(width + 40));
  await expect(headers.nth(2)).toHaveAttribute("aria-sort", "descending");
  await expect(rows.first()).toHaveText("link");
  // A narrower viewport must retain the user widths and allow horizontal scroll.
  await page.setViewportSize({ width: 1024, height: 920 });
  await expect.poll(async () => {
    const geometry = await layout();
    return geometry.scroll > geometry.client && geometry.table > geometry.client;
  }).toBe(true);
  await page.setViewportSize({ width: 2600, height: 920 });
  await expect.poll(async () => {
    const geometry = await layout();
    return Math.abs(geometry.table - geometry.client) <= 1
      && Math.abs(geometry.row - geometry.client) <= 1;
  }).toBe(true);
  expect(await page.evaluate(() => (window as any).__fileListCalls())).toBe(calls);
  await sort("文件名").click();
  await sort("文件名").click();
  await expect(rows).toHaveText(["dir10", "dir2", "link", "file10.txt", "file2.txt", ".hidden"]);
  await page.getByRole("checkbox", { name: "显示隐藏文件" }).uncheck();
  await expect(rows).toHaveCount(5);
  await expect(table.getByRole("checkbox", { name: "选择 file2.txt", exact: true })).toBeChecked();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), FILE_SORT_STORAGE_KEY))
    .toBe(JSON.stringify({ column: "name", direction: "desc" }));
  await page.reload();
  await page.getByRole("button", { name: "连接管理", exact: true }).click();
  await host.locator(".manager-host-name").dblclick();
  await expect(headers.first()).toHaveAttribute("aria-sort", "descending");
  await expect(rows.first()).toHaveText("dir10");
});
