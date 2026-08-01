import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const runtimeErrors = new WeakMap();
const PUBLIC_VIEWPORTS = [
  { height: 568, width: 320 },
  { height: 844, width: 320 },
  { height: 844, width: 390 },
  { height: 1024, width: 768 },
  { height: 900, width: 1440 },
];
const MUTED_SELECTORS = [
  ".lead",
  ".workspace-entry",
  ".availability",
  ".workflow-grid p",
  ".control-list dd",
  ".self-host-copy",
  ".site-footer p",
];

async function readPublicationPalette(page) {
  return page.evaluate((mutedSelectors) => {
    const splitLayers = (value) => {
      const layers = [];
      let depth = 0;
      let start = 0;
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] === "(") depth += 1;
        if (value[index] === ")") depth -= 1;
        if (value[index] !== "," || depth !== 0) continue;
        layers.push(value.slice(start, index).trim());
        start = index + 1;
      }
      layers.push(value.slice(start).trim());
      return layers;
    };
    const root = getComputedStyle(document.documentElement);
    const computed = (selector) => getComputedStyle(document.querySelector(selector));
    return {
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      bodyImages: splitLayers(getComputedStyle(document.body).backgroundImage),
      coralBrightToken: root.getPropertyValue("--coral-bright").trim(),
      mutedColors: Object.fromEntries(mutedSelectors.map((selector) => [
        selector,
        [...document.querySelectorAll(selector)]
          .map((element) => getComputedStyle(element).color),
      ])),
      mutedToken: root.getPropertyValue("--muted").trim(),
      signalBoard: computed(".signal-board").backgroundColor,
      signalGridBackground: computed(".signal-grid").backgroundColor,
      signalGridImages: splitLayers(computed(".signal-grid").backgroundImage),
      signalGridOpacity: computed(".signal-grid").opacity,
      signalIndicator: computed(".signal-topline i").backgroundColor,
      signalIndicatorGlow: computed(".signal-topline i").boxShadow,
      signalMeter: computed(".signal-meter").backgroundColor,
      signalMeterImage: computed(".signal-meter").backgroundImage,
      signalMeterValue: computed(".signal-meter b").color,
    };
  }, MUTED_SELECTORS);
}

async function mutatePublicationStyles(page, mutation) {
  await page.route("**/styles/marketing.css", async (route) => {
    const response = await route.fetch();
    const styles = await response.text();
    await route.fulfill({
      body: `${styles}\n${mutation}\n`,
      response,
    });
  });
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    errors.push(message.text());
  });
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page) ?? [], "The public presentation emitted runtime errors").toEqual([]);
});

test("loads as an honest public presentation when the application API is unavailable", async ({ page }) => {
  const requests = [];
  const failedRequests = [];
  const responses = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  page.on("requestfailed", (request) => failedRequests.push(request.url()));
  page.on("response", (response) => responses.push({
    status: response.status(),
    url: response.url(),
  }));
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
  expect(requests.some((path) => path.endsWith("/app.mjs"))).toBe(false);
  expect(requests.some((path) => path.endsWith("/api/health/live"))).toBe(false);
  expect(requests.some((path) => path.endsWith("/api/public/branding.css"))).toBe(true);
  const pageOrigin = new URL(page.url()).origin;
  expect(
    responses
      .filter(({ url }) => new URL(url).origin === pageOrigin)
      .filter(({ status }) => status < 200 || status >= 400),
  ).toEqual([]);
  expect(
    failedRequests.filter((url) => new URL(url).origin === pageOrigin),
  ).toEqual([]);
});

test("keeps the static presentation within its resource and rendering budgets", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.addInitScript(() => {
    window.__vectorPerformance = { cls: 0, lcp: 0, longTasks: [] };
    if (!window.PerformanceObserver) return;
    if (PerformanceObserver.supportedEntryTypes.includes("layout-shift")) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__vectorPerformance.cls += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    }
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      new PerformanceObserver((list) => {
        window.__vectorPerformance.longTasks.push(
          ...list.getEntries().map((entry) => entry.duration),
        );
      }).observe({ type: "longtask", buffered: true });
    }
    if (PerformanceObserver.supportedEntryTypes.includes("largest-contentful-paint")) {
      new PerformanceObserver((list) => {
        const latest = list.getEntries().at(-1);
        if (latest) window.__vectorPerformance.lcp = latest.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    }
  });
  await page.goto("./", { waitUntil: "load" });
  await page.waitForTimeout(100);

  const metrics = await page.evaluate(() => {
    const localResources = performance.getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).origin === location.origin);
    return {
      cls: window.__vectorPerformance.cls,
      decodedBytes: localResources.reduce((total, entry) => total + entry.decodedBodySize, 0),
      lcp: window.__vectorPerformance.lcp,
      longestTask: Math.max(0, ...window.__vectorPerformance.longTasks),
      resources: localResources.map((entry) => new URL(entry.name).pathname),
      sectionVisibility: Object.fromEntries(
        [".product-tour", ".statement", ".trust-section", ".self-host"]
          .map((selector) => [
            selector,
            getComputedStyle(document.querySelector(selector)).contentVisibility,
          ]),
      ),
      totalBlockingTime: window.__vectorPerformance.longTasks
        .reduce((total, duration) => total + Math.max(0, duration - 50), 0),
    };
  });

  if (process.env.VECTOR_REPORT_PERFORMANCE === "1") {
    console.log(`VECTOR_PERFORMANCE ${JSON.stringify(metrics)}`);
  }
  expect(metrics.resources.sort()).toEqual([
    "/vector-placement-operations/api/public/branding.css",
    "/vector-placement-operations/assets/vector-lockup.svg",
    "/vector-placement-operations/assets/vector-mark.svg",
    "/vector-placement-operations/styles/marketing.css",
    "/vector-placement-operations/styles/shared.css",
  ]);
  expect(metrics.decodedBytes).toBeLessThanOrEqual(42_000);
  expect(metrics.cls).toBeLessThan(0.01);
  expect(metrics.lcp).toBeGreaterThan(0);
  expect(metrics.lcp).toBeLessThan(2_000);
  expect(metrics.longestTask).toBeLessThan(200);
  expect(new Set(Object.values(metrics.sectionVisibility))).toEqual(new Set(["auto"]));
});

test("passes the automated WCAG accessibility gate", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("./", { waitUntil: "load" });
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();

  expect(results.violations).toEqual([]);
  expect(results.incomplete.filter(({ id }) => id === "aria-prohibited-attr")).toEqual([]);
});

test("keeps presentation controls and surfaces distinct in forced-colors mode", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("./", { waitUntil: "load" });
  const primaryAction = page.getByRole("link", { name: /Start the installation/ });
  await primaryAction.focus();
  await expect(primaryAction).toBeFocused();

  const structure = await page.evaluate(() => {
    const style = (selector) => getComputedStyle(document.querySelector(selector));
    const action = style(".button-primary");
    const focus = style(".button-primary");
    const signal = style(".signal-board");
    const workflow = style(".workflow-grid");
    return {
      actionBackground: action.backgroundColor,
      actionBorderStyle: action.borderTopStyle,
      actionBorderWidth: Number.parseFloat(action.borderTopWidth),
      actionColor: action.color,
      focusOutlineStyle: focus.outlineStyle,
      focusOutlineWidth: Number.parseFloat(focus.outlineWidth),
      forcedColors: matchMedia("(forced-colors: active)").matches,
      signalBorderStyle: signal.borderTopStyle,
      signalBorderWidth: Number.parseFloat(signal.borderTopWidth),
      workflowBorderStyle: workflow.borderTopStyle,
      workflowBorderWidth: Number.parseFloat(workflow.borderTopWidth),
    };
  });

  expect(structure.forcedColors).toBe(true);
  expect(structure.actionColor).not.toBe(structure.actionBackground);
  expect(structure.actionBorderStyle).toBe("solid");
  expect(structure.actionBorderWidth).toBeGreaterThanOrEqual(1);
  expect(structure.focusOutlineStyle).toBe("solid");
  expect(structure.focusOutlineWidth).toBeGreaterThanOrEqual(3);
  expect(structure.signalBorderStyle).toBe("solid");
  expect(structure.signalBorderWidth).toBeGreaterThanOrEqual(1);
  expect(structure.workflowBorderStyle).toBe("solid");
  expect(structure.workflowBorderWidth).toBeGreaterThanOrEqual(1);
});

for (const viewport of PUBLIC_VIEWPORTS) {
  test(`resolves every publication colour and background layer at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("./", { waitUntil: "domcontentloaded" });

    const palette = await readPublicationPalette(page);

    expect(palette.mutedToken).toBe("#56626b");
    for (const selector of MUTED_SELECTORS) {
      expect(palette.mutedColors[selector].length, `${selector} must resolve at least once`).toBeGreaterThan(0);
      expect(new Set(palette.mutedColors[selector]), `${selector} must resolve through the cascade`)
        .toEqual(new Set(["rgb(86, 98, 107)"]));
    }
    expect(palette.coralBrightToken).toBe("#ffa599");
    expect(palette.signalMeterValue).toBe("rgb(255, 165, 153)");
    expect(palette.signalIndicator).toBe("rgb(255, 165, 153)");
    expect(palette.signalIndicatorGlow).toContain("rgba(255, 165, 153, 0.15)");
    expect(palette.bodyBackground).toBe("rgb(245, 239, 229)");
    expect(palette.bodyImages).toEqual([
      "linear-gradient(rgba(23, 50, 77, 0.04) 1px, rgba(0, 0, 0, 0) 1px)",
      "linear-gradient(90deg, rgba(23, 50, 77, 0.04) 1px, rgba(0, 0, 0, 0) 1px)",
      "none",
    ]);
    expect(palette.signalBoard).toBe("rgb(23, 50, 77)");
    expect(palette.signalGridBackground).toBe("rgba(0, 0, 0, 0)");
    expect(palette.signalGridImages).toEqual([
      "linear-gradient(rgba(245, 239, 229, 0.055) 1px, rgba(0, 0, 0, 0) 1px)",
      "linear-gradient(90deg, rgba(245, 239, 229, 0.055) 1px, rgba(0, 0, 0, 0) 1px)",
    ]);
    expect(palette.signalGridOpacity).toBe("0.9");
    expect(palette.signalMeter).toBe("rgba(245, 239, 229, 0.06)");
    expect(palette.signalMeterImage).toBe("none");
  });
}

test("detects responsive, per-instance and opaque-layer palette mutations", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 320 });
  await mutatePublicationStyles(page, `
    @media (max-width: 620px) {
      .marketing-page .lead { color: #ffffff; }
    }
    .control-list div:nth-child(2) dd { color: #ffffff; }
    body.marketing-page {
      background-image:
        linear-gradient(#000000, #000000),
        linear-gradient(rgba(23, 50, 77, 0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(23, 50, 77, 0.04) 1px, transparent 1px),
        none;
    }
    .signal-meter { background-image: linear-gradient(#ffffff, #ffffff); }
  `);
  await page.goto("./", { waitUntil: "domcontentloaded" });

  const palette = await readPublicationPalette(page);

  expect(palette.mutedColors[".lead"]).toEqual(["rgb(255, 255, 255)"]);
  expect(palette.mutedColors[".control-list dd"]).toEqual([
    "rgb(86, 98, 107)",
    "rgb(255, 255, 255)",
    "rgb(86, 98, 107)",
    "rgb(86, 98, 107)",
  ]);
  expect(palette.bodyImages).toHaveLength(4);
  expect(palette.bodyImages[0]).toBe(
    "linear-gradient(rgb(0, 0, 0), rgb(0, 0, 0))",
  );
  expect(palette.signalMeterImage).toBe(
    "linear-gradient(rgb(255, 255, 255), rgb(255, 255, 255))",
  );
});

for (const viewport of PUBLIC_VIEWPORTS) {
  test(`keeps the public presentation inside a ${viewport.width}px viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
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
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });

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
    await expect(page.locator(".footer-meta")).toBeVisible();
    await expect(page.locator(".footer-meta")).toContainText("MIT License");
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

test.describe("no-JavaScript public presentation", () => {
  test.use({ javaScriptEnabled: false, reducedMotion: "reduce" });

  test("preserves the complete keyboard and screen-reader path", async ({ page }) => {
    const requests = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("./", { waitUntil: "load" });
    await expect(page.getByRole("heading", { name: "Keep each placement accountable." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "A public product page. A private workspace." })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Project links" })).toBeVisible();
    await expect(page.getByRole("contentinfo")).toContainText("MIT License");

    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to content", exact: true });
    await expect(skipLink).toBeFocused();
    const focusStyle = await skipLink.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      };
    });
    expect(focusStyle.outlineStyle).toBe("solid");
    expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(3);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
    expect(new URL(page.url()).hash).toBe("#content");

    const semantics = await page.evaluate(() => ({
      executableScripts: document.querySelectorAll(
        'script:not([type="application/ld+json"])',
      ).length,
      h1Count: document.querySelectorAll("h1").length,
      mainCount: document.querySelectorAll("main").length,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    }));
    expect(semantics).toEqual({
      executableScripts: 0,
      h1Count: 1,
      mainCount: 1,
      reducedMotion: true,
      scrollBehavior: "auto",
    });

    const structuredData = JSON.parse(
      await page.locator('script[type="application/ld+json"]').textContent(),
    );
    expect(structuredData).toMatchObject({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      isAccessibleForFree: true,
      name: "VECTOR — Placement Operations",
      softwareVersion: "3.3.0",
    });
    expect(requests.some((path) => path.endsWith(".mjs"))).toBe(false);
    expect(requests.some((path) => path.startsWith("/api/") && !path.endsWith("branding.css")))
      .toBe(false);
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
