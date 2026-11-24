import { test, expect } from "@playwright/test";

test("preview workbench preserves host workflows, secrets boundary, themes and compact layout", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("界面预览", { exact: true })).toBeVisible();
  await expect(page.getByText("从一台服务器开始。")).toBeVisible();
  await expect(page.getByText("0 个连接", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await expect(page.locator(".header-center")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /快速查找主机和操作/ })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("workbench-dark-empty.png"),
    fullPage: true,
  });

  // These fixture addresses are documentation-only TEST-NET addresses. No remote API is mocked.
  await page
    .getByRole("button", { name: "新建 SSH 连接", exact: true })
    .click();
  const hostDialog = page.getByRole("dialog", {
    name: "新建 SSH 连接",
    exact: true,
  });
  await hostDialog.getByLabel("连接名称", { exact: true }).fill("开发节点");
  await hostDialog.getByLabel("主机地址", { exact: true }).fill("192.0.2.10");
  await hostDialog.getByLabel("用户名", { exact: true }).fill("ubuntu");
  await hostDialog.getByLabel("分组", { exact: true }).fill("开发环境");
  await page.screenshot({
    path: info.outputPath("host-dialog.png"),
    fullPage: true,
  });
  await expect(hostDialog.getByRole("button", { name: "身份认证", exact: true })).toHaveCount(0);
  await expect(hostDialog.getByLabel("密码保存位置")).toHaveValue("auto");
  await expect(hostDialog.getByText(/无需主密码/)).toBeVisible();
  await hostDialog.getByLabel(/登录密码/).fill("PREVIEW-SECRET-DO-NOT-PERSIST");
  await hostDialog.getByRole("button", { name: "网络", exact: true }).click();
  const selectHeight = await hostDialog.getByLabel("代理类型").evaluate((element) => element.getBoundingClientRect().height);
  const inputHeight = await hostDialog.getByLabel("连接超时（秒）").evaluate((element) => element.getBoundingClientRect().height);
  expect(Math.abs(selectHeight - inputHeight)).toBeLessThanOrEqual(1);
  await hostDialog.getByRole("button", { name: "基础信息", exact: true }).click();
  await expect(hostDialog.getByLabel("密码保存位置")).toHaveValue("auto");
  await expect(
    hostDialog.getByRole("button", { name: "保存并测试握手" }),
  ).toBeDisabled();
  await hostDialog
    .getByRole("button", { name: "保存连接", exact: true })
    .click();
  await expect(hostDialog).not.toBeVisible();
  await expect(
    page.locator(".host-item").filter({ hasText: "开发节点" }),
  ).toBeVisible();
  const persisted = await page.evaluate(() =>
    Object.values(localStorage).join("\n"),
  );
  expect(persisted).not.toContain("PREVIEW-SECRET-DO-NOT-PERSIST");

  const row = () =>
    page.locator(".host-item").filter({ hasText: "开发节点" }).first();
  await row().getByRole("button", { name: "开发节点 更多操作" }).click();
  await expect(page.locator(".context-menu")).toBeVisible();
  await page
    .locator(".context-menu")
    .getByRole("button", { name: "编辑连接", exact: true })
    .click();
  const editDialog = page.getByRole("dialog", {
    name: "编辑连接",
    exact: true,
  });
  await expect(editDialog.getByLabel("主机地址", { exact: true })).toHaveValue(
    "192.0.2.10",
  );
  await editDialog
    .getByLabel("连接名称", { exact: true })
    .fill("开发节点 · 主");
  await editDialog
    .getByRole("button", { name: "保存连接", exact: true })
    .click();
  await row().getByRole("button", { name: "开发节点 · 主 更多操作" }).click();
  await page
    .locator(".context-menu")
    .getByRole("button", { name: "加入收藏", exact: true })
    .click();
  await expect(
    page.locator(".host-item").filter({ hasText: "开发节点 · 主" }),
  ).toHaveCount(2);
  // A favorite is rendered twice, but its menu must open only once.
  await row().getByRole("button", { name: "开发节点 · 主 更多操作" }).click();
  await expect(page.locator(".context-menu")).toHaveCount(1);
  await page
    .locator(".context-menu")
    .getByRole("button", { name: "复制配置", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("连接名称", { exact: true })
    .fill("测试节点");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存连接", exact: true })
    .click();
  await page.getByRole("textbox", { name: "筛选主机" }).fill("测试节点");
  await expect(page.locator(".host-item")).toHaveCount(1);
  await expect(page.locator(".host-item")).toContainText("测试节点");
  await page.getByRole("textbox", { name: "筛选主机" }).clear();

  // Preview never pretends to establish SSH sessions or operate the local computer.
  await row().locator(".host-main").dblclick();
  await expect(
    page
      .locator(".toast")
      .filter({ hasText: "当前是界面预览，请使用桌面应用连接 SSH 服务器。" }),
  ).toBeVisible();
  await expect(page.getByText("0 个连接", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "隧道", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "新建转发", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  const geometry = await page.evaluate(() => {
    const upper = document.querySelector(".workspace-main")!.getBoundingClientRect();
    const files = document.querySelector(".bottom-panel")!.getBoundingClientRect();
    const monitor = document.querySelector(".monitor-panel")!.getBoundingClientRect();
    const terminal = document.querySelector(".terminal-column")!.getBoundingClientRect();
    return {
      dockedBelow: files.top >= upper.bottom - 2,
      fullWidth: Math.abs(files.width - upper.width) < 2,
      monitorBesideTerminal: monitor.left >= terminal.right - 2,
    };
  });
  expect(geometry).toEqual({ dockedBelow: true, fullWidth: true, monitorBesideTerminal: true });
  await page.screenshot({
    path: info.outputPath("workbench-dark.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "设置 ⌘,", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: /雾光浅色/ }).click();
  await settings.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "mist");
  await page.screenshot({
    path: info.outputPath("workbench-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "设置 ⌘,", exact: true }).click();
  await page.getByRole("dialog", { name: "设置", exact: true })
    .getByRole("button", { name: /极光深色/ }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aurora");
  await page.screenshot({ path: info.outputPath("workbench-aurora.png"), fullPage: true });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aurora");
  // Copy preserves the favorite flag, so the restored host appears in both sections.
  const restoredHost = page
    .locator(".host-item")
    .filter({ hasText: "测试节点" });
  await expect(restoredHost).toHaveCount(2);
  await expect(restoredHost.first()).toBeVisible();

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.locator(".titlebar")).toBeVisible();
  await expect(page.locator(".statusbar")).toBeVisible();
  const overflow = await page.evaluate(() => ({
    root: document.documentElement.scrollWidth > innerWidth,
    shell:
      document.querySelector(".app-shell")!.getBoundingClientRect().right >
      innerWidth,
  }));
  expect(overflow).toEqual({ root: false, shell: false });
  await page.screenshot({
    path: info.outputPath("workbench-compact.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
