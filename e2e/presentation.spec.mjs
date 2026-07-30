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

test("resolves the publication palette through the browser cascade", async ({ page }) => {
  await page.goto("./", { waitUntil: "domcontentloaded" });

  const palette = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const mutedSelectors = [
      ".lead",
      ".workspace-entry",
      ".availability",
      ".workflow-grid p",
      ".control-list dd",
      ".self-host-copy",
      ".site-footer p",
    ];
    const computed = (selector) => getComputedStyle(document.querySelector(selector));
    return {
      bodyGrid: getComputedStyle(document.body).backgroundImage,
      coralBrightToken: root.getPropertyValue("--coral-bright").trim(),
      mutedColors: mutedSelectors.map((selector) => computed(selector).color),
      mutedToken: root.getPropertyValue("--muted").trim(),
      signalBoard: computed(".signal-board").backgroundColor,
      signalGrid: computed(".signal-grid").backgroundImage,
      signalGridOpacity: computed(".signal-grid").opacity,
      signalIndicator: computed(".signal-topline i").backgroundColor,
      signalIndicatorGlow: computed(".signal-topline i").boxShadow,
      signalMeter: computed(".signal-meter").backgroundColor,
      signalMeterValue: computed(".signal-meter b").color,
    };
  });

  expect(palette.mutedToken).toBe("#56626b");
  expect(new Set(palette.mutedColors)).toEqual(new Set(["rgb(86, 98, 107)"]));
  expect(palette.coralBrightToken).toBe("#ffa599");
  expect(palette.signalMeterValue).toBe("rgb(255, 165, 153)");
  expect(palette.signalIndicator).toBe("rgb(255, 165, 153)");
  expect(palette.signalIndicatorGlow).toContain("rgba(255, 165, 153, 0.15)");
  expect(palette.signalBoard).toBe("rgb(23, 50, 77)");
  expect(palette.signalGridOpacity).toBe("0.9");
  expect(palette.signalMeter).toBe("rgba(245, 239, 229, 0.06)");
  expect(palette.bodyGrid.match(/rgba\(23, 50, 77, 0\.04\)/g)).toHaveLength(2);
  expect(palette.signalGrid.match(/rgba\(245, 239, 229, 0\.055\)/g)).toHaveLength(2);
});

for (const width of [320, 390, 1440]) {
  test(`keeps the public presentation inside a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    await page.goto("./", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-api-status]")).toContainText("public product page");

    const layout = await page.evaluate(() => {
      const heading = document.querySelector("h1").getBoundingClientRect();
      return {
        body: document.body.scrollWidth,
        document: document.documentElement.scrollWidth,
        headingLeft: heading.left,
        headingRight: heading.right,
        viewport: document.documentElement.clientWidth,
      };
    });

    expect(layout.document).toBeLessThanOrEqual(layout.viewport);
    expect(layout.body).toBeLessThanOrEqual(layout.viewport);
    expect(layout.headingLeft).toBeGreaterThanOrEqual(0);
    expect(layout.headingRight).toBeLessThanOrEqual(layout.viewport);
  });
}

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
