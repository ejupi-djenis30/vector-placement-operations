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
  await expect(page.getByRole("link", { name: /Start the installation/ })).toHaveAttribute("href", "#self-host");
  await expect(page.getByRole("link", { name: /Download v3.3.0/ })).toHaveAttribute(
    "href",
    "https://github.com/ejupi-djenis30/vector-placement-operations/releases/tag/v3.3.0",
  );
  await expect(page.locator("[data-api-status]")).toContainText("public product page");
  await expect(page.locator("[data-workspace-link]").first()).toHaveAttribute("href", "#self-host");
  await expect(page.locator("[data-workspace-link]").first()).toContainText("Installation required");
  await expect(page.locator("[data-workspace-link]").first()).toHaveAttribute(
    "aria-label",
    "Installation required; read the self-hosting setup path",
  );
  await expect(page.getByRole("heading", { name: "A public product page. A private workspace." })).toBeVisible();
  await expect(page.getByRole("link", { name: /complete installation guide/ })).toHaveAttribute(
    "href",
    "https://github.com/ejupi-djenis30/vector-placement-operations/blob/main/docs/self-hosting.md",
  );
  await expect(page.getByRole("link", { name: /Get the v3.3.0 release/ })).toHaveAttribute(
    "href",
    "https://github.com/ejupi-djenis30/vector-placement-operations/releases/tag/v3.3.0",
  );
});

test.describe("mobile public presentation", () => {
  test.use({ viewport: { width: 320, height: 800 }, hasTouch: true, isMobile: true });

  test("remains inside the viewport without an API-backed workspace", async ({ page }) => {
    await page.goto("./", { waitUntil: "domcontentloaded" });
    await page.locator(".skip-link").focus();
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
    await expect(page.locator("[data-api-status]")).toContainText("public product page");
  });

  test("keeps every public action large enough to tap", async ({ page }) => {
    await page.goto("./", { waitUntil: "domcontentloaded" });
    await page.locator(".skip-link").focus();

    const undersized = await page
      .locator(
        [
          ".skip-link",
          ".site-header .brand",
          ".header-action",
          ".hero-actions a",
          ".self-host-actions a",
          ".site-footer a",
        ].join(","),
      )
      .evaluateAll((elements) =>
        elements
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              height: rect.height,
              label: element.getAttribute("aria-label") ?? element.textContent.trim(),
              width: rect.width,
            };
          })
          .filter(({ height, width }) => height < 44 || width < 44),
      );

    expect(undersized).toEqual([]);
  });
});
