import { expect, test } from "@playwright/test";

const runtimeErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/Failed to load resource:.*status of 404/.test(message.text())) return;
    errors.push(message.text());
  });
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page) ?? [], "The public presentation emitted runtime errors").toEqual([]);
});

test("loads as an honest public presentation when the application API is unavailable", async ({ page }) => {
  await page.goto("./", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Keep each placement accountable." })).toBeVisible();
  await expect(page.locator(".signal-path li")).toHaveCount(3);
  await expect(page.locator("[data-api-status]")).toContainText("public product page");
  await expect(page.locator("[data-workspace-link]").first()).toHaveAttribute("href", "#self-host");
  await expect(page.getByRole("heading", { name: "A public product page. A private workspace." })).toBeVisible();
});

test.describe("mobile public presentation", () => {
  test.use({ viewport: { width: 320, height: 800 }, hasTouch: true, isMobile: true });

  test("remains inside the viewport without an API-backed workspace", async ({ page }) => {
    await page.goto("./", { waitUntil: "domcontentloaded" });
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
    await expect(page.locator("[data-api-status]")).toContainText("public product page");
  });
});
