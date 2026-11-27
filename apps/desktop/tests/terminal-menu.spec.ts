import { expect, test } from "@playwright/test";
import { TERMINAL_BACKGROUND_KEY } from "../src/terminalBackground";

test.use({ locale: "zh-CN" });

test("terminal context menu supports clipboard, safe multiline paste, find, buffer clear and local wallpaper", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    let callback = 0, channelId = 0, eventIndex = 0, allowPaste = false, confirmations = 0;
    const handlers = new Map<number, (raw: unknown) => void>();
    const writes: string[] = [];
    Object.defineProperty(window, "isTauri", { value: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: (handler: (raw: unknown) => void) => {
        handlers.set(++callback, handler);
        return callback;
      },
      unregisterCallback: (id: number) => handlers.delete(id),
      invoke: async (cmd: string, args: Record<string, any> = {}) => {
        switch (cmd) {
          case "hosts_list": case "host_groups_list": case "snippets_list":
          case "transfers_list": case "tunnels_list": return [];
          case "settings_get": case "workspace_get": return {};
          case "workspace_save": return args.workspace;
          case "monitor_window_is_open": return false;
          case "local_open":
            channelId = args.onEvent.id;
            eventIndex = 0;
            return "local-fixture";
          case "terminal_write": writes.push(atob(args.data)); return null;
          case "plugin:dialog|message": confirmations++; return allowPaste ? "确认" : "取消";
          case "plugin:event|listen": return ++callback;
          default: return null;
        }
      },
    }});
    Object.defineProperty(window, "__termFixture", { value: {
      emit: (value: string) => handlers.get(channelId)?.({
        index: eventIndex, message: {
          type: "data", sessionId: "local-fixture", data: btoa(value), sequence: ++eventIndex,
        },
      }),
      writes: () => writes.join(""),
      confirmations: () => confirmations,
      allowPaste: () => { allowPaste = true; },
    }});
  });
  await page.goto("/");
  const open = async () => {
    await page.getByRole("button", { name: "连接管理", exact: true }).click();
    await page.getByRole("dialog", { name: "连接管理" }).getByRole("button", { name: "本地终端", exact: true }).click();
    await expect(page.locator(".terminal-view.visible .xterm")).toBeVisible();
  };
  await open();
  await page.evaluate(() => (window as any).__termFixture.emit("alpha bravo\r\nprompt$ "));
  const canvas = page.locator(".terminal-view.visible .terminal-canvas");
  const menu = page.getByRole("menu", { name: "终端右键菜单" });
  const action = (name: string) => menu.getByRole("menuitem", { name, exact: false });
  const show = () => canvas.click({ button: "right", position: { x: 100, y: 100 } });
  await expect(canvas.locator(".xterm-rows")).toContainText("alpha bravo");
  await show();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^复制/ })).toBeDisabled();
  await expect(action("粘贴选中")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // Select a word in the real xterm renderer, not a mock selection API.
  const firstRow = canvas.locator(".xterm-rows > div").first();
  const box = (await firstRow.boundingBox())!;
  await page.mouse.dblclick(box.x + 12, box.y + box.height / 2);
  await page.mouse.click(box.x + 12, box.y + box.height / 2, { button: "right" });
  await expect(menu.getByRole("menuitem", { name: /^复制/ })).toBeEnabled();
  await menu.getByRole("menuitem", { name: /^复制/ }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("alpha");
  await page.mouse.dblclick(box.x + 12, box.y + box.height / 2);
  await page.mouse.click(box.x + 12, box.y + box.height / 2, { button: "right" });
  await action("粘贴选中").click();
  await expect.poll(() => page.evaluate(() => (window as any).__termFixture.writes())).toBe("alpha");
  await page.evaluate(() => navigator.clipboard.writeText("single"));
  await show();
  await menu.getByRole("menuitem", { name: /^粘贴(?!选中)/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__termFixture.writes())).toBe("alphasingle");
  await page.evaluate(() => navigator.clipboard.writeText("one\ntwo"));
  await show();
  await menu.getByRole("menuitem", { name: /^粘贴(?!选中)/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__termFixture.confirmations())).toBe(1);
  expect(await page.evaluate(() => (window as any).__termFixture.writes())).toBe("alphasingle");
  await page.evaluate(() => (window as any).__termFixture.allowPaste());
  await show();
  await menu.getByRole("menuitem", { name: /^粘贴(?!选中)/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__termFixture.confirmations())).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as any).__termFixture.writes())).toBe("alphasingleone\rtwo");
  await show();
  await action("查找").click();
  const search = page.getByPlaceholder("在终端中查找");
  await expect(search).toBeFocused();
  await search.fill("bravo");
  await page.keyboard.press("Escape");
  await show();
  await action("清空缓存").click();
  await expect(canvas.locator(".xterm-rows")).not.toContainText("alpha bravo");
  await expect(canvas.locator(".xterm-rows")).toContainText("prompt$");
  expect(await page.evaluate(() => (window as any).__termFixture.writes())).toBe("alphasingleone\rtwo");
  const chooserPromise = page.waitForEvent("filechooser");
  await show();
  await action("设置背景图片").click();
  const chooser = await chooserPromise;
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 32; c.height = 32;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#e6c820"; ctx.fillRect(0, 0, 32, 32);
    return c.toDataURL("image/png").split(",")[1];
  });
  await chooser.setFiles({ name: "wallpaper.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(page.locator(".terminal-view.visible")).toHaveClass(/has-background/);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), TERMINAL_BACKGROUND_KEY)).toMatch(/^data:image\/jpeg;base64,/);
  await expect(canvas.locator(".xterm-viewport")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.reload();
  await open();
  await expect(page.locator(".terminal-view.visible")).toHaveClass(/has-background/);
  await show();
  await action("恢复默认背景").click();
  await expect(page.locator(".terminal-view.visible")).not.toHaveClass(/has-background/);
  expect(await page.evaluate((key) => localStorage.getItem(key), TERMINAL_BACKGROUND_KEY)).toBeNull();
});
