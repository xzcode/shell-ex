import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test.use({ locale: "zh-CN" });

test("macOS overlay preserves native window controls and limits drag permission", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const main = config.app.windows.find((item: { label: string }) => item.label === "main");
  expect(main.decorations).toBe(true);
  expect(main.titleBarStyle).toBe("Overlay");
  expect(main.hiddenTitle).toBe(true);
  expect(main.trafficLightPosition).toEqual({ x: 14, y: 14 });
  const capability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/mac-titlebar.json", import.meta.url), "utf8"));
  expect(capability.platforms).toEqual(["macOS"]);
  expect(capability.windows).toEqual(["main"]);
  expect(capability.permissions).toContain("core:window:allow-start-dragging");
});

test("native macOS toolbar reserves traffic-light space without making settings draggable", async ({ page }) => {
  // A browser fixture checks only layout and click boundaries. It does not emulate AppKit.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    Object.defineProperty(window, "isTauri", { value: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback: () => 1,
        invoke: async (command: string) => {
          if (command === "hosts_list" || command === "snippets_list" || command === "transfers_list") return [];
          if (command === "update_config") return { configured: false, version: "0.4.6", reason: "" };
          if (command === "vault_status") return { initialized: false, unlocked: false, count: 0 };
          return {};
        },
      },
    });
  });
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto("/");
  const header = page.locator(".titlebar.mac-titlebar");
  await expect(header).toBeVisible();
  await expect(header).toHaveCSS("padding-left", "100px");
  await expect(header.locator(".titlebar-drag")).toHaveAttribute("data-tauri-drag-region", "");
  const geometry = await header.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    inset: el.querySelector(".brand")!.getBoundingClientRect().left - el.getBoundingClientRect().left,
    drag: el.querySelector(".titlebar-drag")!.getBoundingClientRect().width,
  }));
  expect(geometry.height).toBe(42);
  expect(geometry.inset).toBeGreaterThanOrEqual(100);
  expect(geometry.drag).toBeGreaterThan(0);
  const button = header.getByRole("button", { name: "设置 ⌘,", exact: true });
  await expect(button).not.toHaveAttribute("data-tauri-drag-region", "");
  await button.click();
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
});

test("macOS browser preview keeps the ordinary header without native drag targets", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
  await page.goto("/");
  await expect(page.locator(".titlebar")).toBeVisible();
  await expect(page.locator(".mac-titlebar")).toHaveCount(0);
  await expect(page.locator(".titlebar [data-tauri-drag-region]")).toHaveCount(0);
});
