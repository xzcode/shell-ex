import { test, expect } from "@playwright/test";
import { themePalettes } from "../src/themePalettes";

test.use({ locale: "zh-CN" });

function luminance(hex: string) {
  const channels = hex.trim().replace(/^#/, "").match(/.{2}/g)!.slice(0, 3)
    .map((part) => parseInt(part, 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("seven workspace themes have matching previews, differentiated regions, readable colors and persistent selection", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  const names = ["black", "gray", "graphite", "aurora", "soft-white", "mist", "light"] as const;
  const regions = [
    [".titlebar", "--surface-title"],
    [".session-bar", "--surface-tabs"],
    [".terminal-area", "--terminal"],
    [".bottom-panel", "--surface-files"],
    [".panel-tabs", "--surface-tools"],
    [".monitor-panel", "--surface-monitor"],
    [".statusbar", "--surface-status"],
  ] as const;
  for (const id of names) {
    await page.getByRole("button", { name: "设置 ⌘,", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(settings.locator(".theme-card")).toHaveCount(7);
    const card = settings.locator(".theme-card." + id);
    const miniature = card.locator(".theme-mini");
    const swatches = await miniature.evaluate((el) => {
      const tokens = getComputedStyle(el);
      return ["--surface-title", "--surface-sidebar", "--terminal", "--surface-monitor", "--surface-files"]
        .map((key) => tokens.getPropertyValue(key).trim());
    });
    await card.click();
    await expect(card).toHaveAttribute("aria-pressed", "true");
    await settings.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    const result = await page.evaluate((regions) => {
      const tokens = getComputedStyle(document.documentElement);
      const surface = (key: string) => tokens.getPropertyValue(key).trim();
      const toRGB = (hex: string) => {
        const number = parseInt(hex.slice(1), 16);
        return "rgb(" + [number >> 16, (number >> 8) & 255, number & 255].join(", ") + ")";
      };
      return {
        previews: ["--surface-title", "--surface-sidebar", "--terminal", "--surface-monitor", "--surface-files"].map(surface),
        regions: regions.map(([selector, token]) => ({
          selector, expected: toRGB(surface(token)),
          actual: getComputedStyle(document.querySelector(selector)!).backgroundColor,
        })),
        surfaces: ["--surface-title", "--surface-sidebar", "--surface-tabs", "--terminal",
          "--surface-tools", "--surface-tree", "--surface-files", "--surface-table-head",
          "--surface-monitor", "--surface-card", "--surface-status", "--bg", "--panel", "--panel-alt"].map(surface),
        text: surface("--text"), muted: surface("--muted"), secondary: surface("--secondary"),
        primary: surface("--accent-strong"), primaryFg: surface("--primary-fg"),
        terminal: surface("--terminal"), scheme: tokens.colorScheme,
      };
    }, regions);
    expect(result.previews).toEqual(swatches);
    expect(new Set(result.previews).size, id + " major region colors").toBe(5);
    for (const region of result.regions) expect(region.actual, id + " " + region.selector).toBe(region.expected);
    expect(result.terminal).toBe(themePalettes[id].terminal.background);
    expect(result.terminal).toBe(themePalettes[id].editor.background);
    expect(result.scheme).toBe(["soft-white", "mist", "light"].includes(id) ? "light" : "dark");
    for (const surface of result.surfaces) {
      expect(contrast(result.text, surface), id + " primary text on " + surface).toBeGreaterThanOrEqual(4.5);
      expect(contrast(result.secondary, surface), id + " secondary text on " + surface).toBeGreaterThanOrEqual(4.5);
      expect(contrast(result.muted, surface), id + " muted text on " + surface).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(result.primary, result.primaryFg), id + " primary button").toBeGreaterThanOrEqual(4.5);
    if (id === "gray" || id === "soft-white") {
      await page.screenshot({ path: info.outputPath("workbench-" + id + ".png") });
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    }
  }
});
