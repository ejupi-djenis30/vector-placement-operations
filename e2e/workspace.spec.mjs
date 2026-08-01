import { readFile } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const E2E_EMAIL = "vector-e2e-admin@example.test";
const E2E_BOOTSTRAP_PASSWORD = process.env.VECTOR_E2E_PASSWORD ?? "vector-e2e-password-2026";
const E2E_PASSWORD = "vector-e2e-permanent-password-2026";
const COORDINATOR_EMAIL = "coordinator.e2e@example.test";
const COORDINATOR_TEMP_PASSWORD = "coordinator-temporary-password-2026";
const COORDINATOR_PASSWORD = "coordinator-accessibility-password-2026";
const VIEWER_EMAIL = "viewer.e2e@example.test";
const VIEWER_TEMP_PASSWORD = "viewer-temporary-password-2026";
const VIEWER_RESET_PASSWORD = "viewer-reset-password-2026";
const VIEWER_PASSWORD = "viewer-permanent-password-2026";
const VIEWER_ACCESSIBILITY_PASSWORD = "viewer-accessibility-password-2026";
const TUTOR_EMAIL = "tutor.e2e@example.test";
const TUTOR_TEMP_PASSWORD = "tutor-temporary-password-2026";
const TUTOR_PASSWORD = "tutor-permanent-password-2026";
const TUTOR_ACCESSIBILITY_PASSWORD = "tutor-accessibility-password-2026";
const runtimeErrors = new WeakMap();
const expectedHttpFailures = new WeakMap();
const expectedConsoleFailures = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  expectedHttpFailures.set(page, new Set());
  expectedConsoleFailures.set(page, new Set());
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const status = Number(message.text().match(/Failed to load resource:.*status of (\d+)/)?.[1]);
    if (status && expectedHttpFailures.get(page)?.has(status)) return;
    if (
      [...(expectedConsoleFailures.get(page) ?? [])]
        .some((pattern) => pattern.test(message.text()))
    ) {
      return;
    }
    errors.push(message.text());
  });
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page) ?? [], "The workspace emitted runtime errors").toEqual([]);
});

async function withExpectedHttpFailure(page, status, action) {
  const statuses = expectedHttpFailures.get(page);
  statuses?.add(status);
  try {
    return await action();
  } finally {
    await page.waitForTimeout(50);
    statuses?.delete(status);
  }
}

async function withExpectedConsoleFailure(page, pattern, action) {
  const patterns = expectedConsoleFailures.get(page);
  patterns?.add(pattern);
  try {
    return await action();
  } finally {
    await page.waitForTimeout(50);
    patterns?.delete(pattern);
  }
}

async function submitLogin(page, password, email = E2E_EMAIL) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  return withExpectedHttpFailure(page, 401, async () => {
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/auth/login") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    return responsePromise;
  });
}

async function signIn(page) {
  await page.goto("/app/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Sign in to the workspace." })).toBeVisible();

  let password = E2E_PASSWORD;
  let response = await submitLogin(page, password);
  if (!response.ok()) {
    password = E2E_BOOTSTRAP_PASSWORD;
    response = await submitLogin(page, password);
  }
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  if (session.user.mustChangePassword) {
    await expect(page.getByRole("heading", { name: "Set a permanent password." })).toBeVisible();
    await page.getByLabel("Current temporary password").fill(password);
    await page.getByLabel("New password", { exact: true }).fill(E2E_PASSWORD);
    await page.getByLabel("Confirm new password", { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Set permanent password", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in to the workspace." })).toBeVisible();
    const permanentResponse = await submitLogin(page, E2E_PASSWORD);
    expect(permanentResponse.ok()).toBeTruthy();
  }
  await expect(page.getByRole("heading", { name: /^(?:Keep the next action visible\.|Know what needs attention next\.)$/ })).toBeVisible();
}

async function signInAs(page, { email, temporaryPassword, permanentPassword }) {
  await page.goto("/app/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Sign in to the workspace." })).toBeVisible();
  let password = temporaryPassword;
  let response = await submitLogin(page, password, email);
  if (!response.ok()) {
    password = permanentPassword;
    response = await submitLogin(page, password, email);
  }
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  if (session.user.mustChangePassword) {
    await expect(page.getByRole("heading", { name: "Set a permanent password." })).toBeVisible();
    await page.getByLabel("Current temporary password").fill(password);
    await page.getByLabel("New password", { exact: true }).fill(permanentPassword);
    await page.getByLabel("Confirm new password", { exact: true }).fill(permanentPassword);
    await page.getByRole("button", { name: "Set permanent password", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in to the workspace." })).toBeVisible();
    const permanentLogin = await submitLogin(page, permanentPassword, email);
    expect(permanentLogin.ok()).toBeTruthy();
  }
  await expect(page.getByRole("heading", { name: /^(?:Keep the next action visible\.|Know what needs attention next\.)$/ })).toBeVisible();
}

async function ensureUserViaUi(page, { email, displayName, role, temporaryPassword }) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const existing = page.locator(".user-row").filter({ hasText: email });
  if (await existing.count()) return;
  await page.getByRole("button", { name: "New user", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Display name").fill(displayName);
  await dialog.getByLabel("Role").selectOption(role);
  await dialog.getByLabel("Temporary password").fill(temporaryPassword);
  await dialog.getByRole("button", { name: "Create user", exact: true }).click();
  await expect(page.locator(".user-row").filter({ hasText: email })).toBeVisible();
}

async function resetUserPasswordViaUi(page, { email, temporaryPassword }) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const row = page.locator(".user-row").filter({ hasText: email });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Reset password", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("New temporary password").fill(temporaryPassword);
  await dialog.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function openPlacement(page, studentName) {
  await page.getByRole("button", { name: "Placements", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Every placement, in context." })).toBeVisible();
  const row = page.locator(".data-table tbody tr").filter({ hasText: studentName });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: /hours logged/ })).toBeVisible();
}

async function expectWorkspaceSemantics(page, label) {
  const semantics = await page.evaluate(() => {
    const headings = [...document.querySelectorAll("main h1, main h2, main h3, main h4, main h5, main h6")]
      .map((heading) => ({
        level: Number(heading.localName.slice(1)),
        text: heading.textContent.trim(),
      }));
    return {
      currentPages: document.querySelectorAll('nav[aria-label="Workspace navigation"] [aria-current="page"]').length,
      headingJumps: headings
        .slice(1)
        .filter((heading, index) => heading.level > headings[index].level + 1),
      headings,
      h1Count: document.querySelectorAll("main h1").length,
      mainCount: document.querySelectorAll("main").length,
      namedWorkspaceNavCount: document.querySelectorAll('nav[aria-label="Workspace navigation"]').length,
    };
  });

  expect(semantics.mainCount, `${label}: one main landmark`).toBe(1);
  expect(semantics.namedWorkspaceNavCount, `${label}: named workspace navigation`).toBe(1);
  expect(semantics.currentPages, `${label}: one current navigation item`).toBe(1);
  expect(semantics.h1Count, `${label}: one page heading`).toBe(1);
  expect(semantics.headings[0]?.level, `${label}: the outline starts at h1`).toBe(1);
  expect(semantics.headingJumps, `${label}: heading levels do not skip`).toEqual([]);
}

async function expectNoWorkspaceOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const selectors = [
      "#app",
      ".workspace-sidebar",
      ".workspace-main",
      ".workspace-topbar",
      ".view-header",
      ".workspace-card",
      ".loading-card",
      ".login-card",
      ".unavailable-card",
      ".modal",
      ".modal-card",
    ];
    const offenders = [...document.querySelectorAll(selectors.join(","))]
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          selector: node.id ? `#${node.id}` : `.${node.classList[0]}`,
          width: Math.round(rect.width * 10) / 10,
        };
      })
      .filter(({ left, right, width }) => left < -1 || right > viewportWidth + 1 || width > viewportWidth + 1);
    return {
      bodyWidth: document.body.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      offenders,
      viewportWidth,
    };
  });

  expect(overflow.documentWidth, `${label}: document width`).toBeLessThanOrEqual(overflow.viewportWidth + 1);
  expect(overflow.bodyWidth, `${label}: body width`).toBeLessThanOrEqual(overflow.viewportWidth + 1);
  expect(overflow.offenders, `${label}: core workspace surfaces fit the viewport`).toEqual([]);
}

async function expectCurrentWorkspaceNavigationVisible(page, label) {
  const layout = await page.evaluate(() => {
    const navigation = document.querySelector('nav[aria-label="Workspace navigation"]');
    const current = navigation?.querySelector('[aria-current="page"]');
    const sidebar = navigation?.closest(".workspace-sidebar");
    const brand = sidebar?.querySelector(".brand");
    if (!navigation || !current || !sidebar || !brand) return null;
    const brandRect = brand.getBoundingClientRect();
    const navigationRect = navigation.getBoundingClientRect();
    const currentRect = current.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const navigationStyle = getComputedStyle(navigation);
    let webkitScrollbarDisplay = "";
    try {
      webkitScrollbarDisplay = getComputedStyle(navigation, "::-webkit-scrollbar").display;
    } catch {
      // Engines without WebKit pseudo-element inspection expose scrollbar-width instead.
    }
    return {
      brandLeft: brandRect.left,
      brandRight: brandRect.right,
      brandWidth: brandRect.width,
      compact: matchMedia("(max-width: 900px)").matches,
      currentLeft: currentRect.left,
      currentRight: currentRect.right,
      currentView: current.dataset.view,
      navigationClientWidth: navigation.clientWidth,
      navigationLeft: navigationRect.left,
      navigationOverflowX: navigationStyle.overflowX,
      navigationRight: navigationRect.right,
      navigationScrollLeft: navigation.scrollLeft,
      navigationScrollWidth: navigation.scrollWidth,
      nativeScrollbarHidden: navigationStyle.scrollbarWidth === "none"
        || webkitScrollbarDisplay === "none",
      pageScrollLeft: window.scrollX,
      sidebarLeft: sidebarRect.left,
      sidebarOverflowX: getComputedStyle(sidebar).overflowX,
      sidebarRight: sidebarRect.right,
      sidebarScrollLeft: sidebar.scrollLeft,
    };
  });

  expect(layout, `${label}: workspace navigation exists`).not.toBeNull();
  expect(layout.currentLeft, `${label}: current navigation item starts inside the nav`)
    .toBeGreaterThanOrEqual(layout.navigationLeft - 1);
  expect(layout.currentRight, `${label}: current navigation item ends inside the nav`)
    .toBeLessThanOrEqual(layout.navigationRight + 1);
  expect(layout.pageScrollLeft, `${label}: navigation alignment does not scroll the page`).toBe(0);
  expect(layout.sidebarScrollLeft, `${label}: navigation alignment does not scroll the sidebar`).toBe(0);
  expect(layout.brandWidth, `${label}: the workspace brand remains rendered`).toBeGreaterThan(0);
  expect(layout.brandLeft, `${label}: the workspace brand starts inside the sidebar`)
    .toBeGreaterThanOrEqual(layout.sidebarLeft - 1);
  expect(layout.brandRight, `${label}: the workspace brand ends inside the sidebar`)
    .toBeLessThanOrEqual(layout.sidebarRight + 1);
  if (layout.compact) {
    expect(layout.brandRight, `${label}: the mobile brand does not slide underneath the nav`)
      .toBeLessThanOrEqual(layout.navigationLeft + 1);
    expect(layout.sidebarOverflowX, `${label}: the mobile sidebar clips only its outer overflow`).toBe("clip");
    expect(layout.navigationOverflowX, `${label}: the mobile nav remains horizontally scrollable`).toBe("auto");
    expect(layout.nativeScrollbarHidden, `${label}: the mobile nav hides its native scrollbar`).toBe(true);
    if (
      layout.currentView === "settings"
      && layout.navigationScrollWidth > layout.navigationClientWidth + 1
    ) {
      expect(layout.navigationScrollLeft, `${label}: the final current item advances the nav scroll`)
        .toBeGreaterThan(0);
    }
  }
}

async function expectAxeClean(page, label) {
  const results = await withExpectedConsoleFailure(
    page,
    /^Refused to apply a stylesheet because .*Content Security Policy\.$/,
    () => new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze(),
  );
  const violations = results.violations.map(({ help, id, impact, nodes }) => ({
    help,
    id,
    impact,
    targets: nodes.map((node) => node.target),
  }));

  expect(violations, `${label}: WCAG 2.2 AA Axe violations`).toEqual([]);
  expect(
    results.incomplete.filter(({ id }) => id === "aria-prohibited-attr"),
    `${label}: prohibited ARIA attributes must be resolved`,
  ).toEqual([]);
}

async function auditWorkspaceView(page, {
  heading,
  label,
  navigation,
  viewport,
}) {
  await page.setViewportSize(viewport);
  if (navigation) {
    await page.getByRole("button", { name: navigation, exact: true }).click();
  }
  await expect(page.locator(".view-header h1")).toHaveText(heading);
  await expectWorkspaceSemantics(page, label);
  await expectNoWorkspaceOverflow(page, label);
  await expectCurrentWorkspaceNavigationVisible(page, label);
  await expectAxeClean(page, label);
}

test("boots the login screen without a redundant health preflight", async ({ page }) => {
  const apiRequests = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) apiRequests.push(path);
  });
  const workspaceAsset = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/app/workspace.mjs",
  );

  await page.goto("/app/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Sign in to the workspace." })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Skip to workspace", exact: true }),
  ).toBeHidden();
  await expect(page.locator("#app")).not.toHaveAttribute("aria-live");
  expect(apiRequests).toContain("/api/public/branding");
  expect(apiRequests).toContain("/api/session");
  expect(apiRequests).not.toContain("/api/health/live");
  const bootTimings = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => [
      "/api/public/branding",
      "/api/session",
    ].includes(new URL(entry.name).pathname))
    .map((entry) => ({
      duration: entry.duration,
      path: new URL(entry.name).pathname,
      startTime: entry.startTime,
    })));
  expect(bootTimings).toHaveLength(2);
  expect(
    Math.abs(bootTimings[0].startTime - bootTimings[1].startTime),
  ).toBeLessThan(50);
  const stylesheetGraph = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => new URL(entry.name).pathname.endsWith(".css"))
    .map((entry) => ({
      decodedBytes: entry.decodedBodySize,
      path: new URL(entry.name).pathname,
    })));
  expect(stylesheetGraph.map(({ path }) => path).sort()).toEqual([
    "/api/public/branding.css",
    "/styles/shared.css",
    "/styles/workspace.css",
  ]);
  expect(stylesheetGraph.reduce((total, entry) => total + entry.decodedBytes, 0))
    .toBeLessThanOrEqual(32_000);
  if (process.env.VECTOR_REPORT_PERFORMANCE === "1") {
    console.log(`VECTOR_BOOT ${JSON.stringify(bootTimings)}`);
  }
  const assetResponse = await workspaceAsset;
  expect(assetResponse.headers()["content-encoding"]).toMatch(/^(?:br|gzip)$/);
  expect(assetResponse.headers()["ratelimit-policy"]).toBeUndefined();
  await expect(page.getByRole("main")).toHaveClass(/login-card/);
});

test("recovers from a temporary workspace boot outage without reloading the page", async ({ page }) => {
  await page.setViewportSize({ height: 568, width: 320 });
  let sessionAttempts = 0;
  await page.route("**/api/session", async (route) => {
    sessionAttempts += 1;
    if (sessionAttempts === 1) {
      await route.fulfill({
        body: JSON.stringify({
          error: {
            code: "not_ready",
            message: "The workspace is still starting.",
            requestId: "vector-e2e-recovery",
          },
        }),
        contentType: "application/json",
        headers: { "x-request-id": "vector-e2e-recovery" },
        status: 503,
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.continue();
  });

  await withExpectedHttpFailure(page, 503, () => page.goto("/app/", {
    waitUntil: "networkidle",
  }));
  const heading = page.getByRole("heading", {
    name: "The workspace is temporarily unavailable.",
  });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByRole("main")).toHaveClass(/unavailable-card/);
  await expect(page.getByText("Request ID: vector-e2e-recovery")).toBeVisible();
  await expect(page.locator("#app")).not.toHaveAttribute("aria-live");
  await expect(page.locator("#app")).not.toHaveAttribute("aria-busy");
  await expectNoWorkspaceOverflow(page, "mobile workspace recovery");
  await expectAxeClean(page, "mobile workspace recovery");
  const undersizedActions = await page.locator(".unavailable-actions .button")
    .evaluateAll((actions) => actions.map((action) => {
      const rect = action.getBoundingClientRect();
      return { height: rect.height, width: rect.width };
    }).filter(({ height, width }) => height < 44 || width < 44));
  expect(undersizedActions).toEqual([]);

  const retry = page.locator(".unavailable-actions button");
  await expect(retry).toHaveAccessibleName("Try again");
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveText("Trying again…");
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("heading", { name: "Sign in to the workspace." })).toBeVisible();
  await expect(page.getByRole("main")).toHaveClass(/login-card/);
  await expect(page.locator("#app")).not.toHaveAttribute("aria-busy");
  expect(sessionAttempts).toBe(2);
});

test("forces the bootstrap password to be replaced before loading workspace data", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const workspaceRequests = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(dashboard|placements|students|hosts|reference-data|audit|users)(?:\/|$)/.test(path)) workspaceRequests.push(path);
  });

  await page.goto("/app/", { waitUntil: "networkidle" });
  const loginResponse = await submitLogin(page, E2E_BOOTSTRAP_PASSWORD);
  expect(loginResponse.ok()).toBeTruthy();
  await expect(page.getByRole("heading", { name: "Set a permanent password." })).toBeVisible();
  expect(workspaceRequests).toEqual([]);

  await page.getByLabel("Current temporary password").fill("incorrect-temporary-password");
  await page.getByLabel("New password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel("Confirm new password", { exact: true }).fill(E2E_PASSWORD);
  const rejectedChange = await withExpectedHttpFailure(page, 422, async () => {
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/auth/change-password") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Set permanent password", exact: true }).click();
    return responsePromise;
  });
  expect(rejectedChange.status()).toBe(422);
  await expect(page.getByRole("heading", { name: "Set a permanent password." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Set permanent password", exact: true })).toBeEnabled();
  expect(workspaceRequests).toEqual([]);

  await page.getByLabel("Current temporary password").fill(E2E_BOOTSTRAP_PASSWORD);
  const acceptedChange = page.waitForResponse((response) => response.url().endsWith("/api/auth/change-password") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Set permanent password", exact: true }).click();
  expect((await acceptedChange).ok()).toBeTruthy();
  await expect(page.getByRole("heading", { name: "Sign in to the workspace." })).toBeVisible();

  const permanentLogin = await submitLogin(page, E2E_PASSWORD);
  expect(permanentLogin.ok()).toBeTruthy();
  await expect(page.getByRole("heading", { name: /^(?:Keep the next action visible\.|Know what needs attention next\.)$/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator(".workspace-topbar")).toBeInViewport();
});

test("keeps login, workspace status and dialogs distinct in forced-colors mode", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/app/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Sign in to the workspace." })).toBeVisible();
  const signInButton = page.getByRole("button", { name: "Sign in", exact: true });
  await signInButton.focus();
  const loginStructure = await page.evaluate(() => {
    const card = getComputedStyle(document.querySelector(".login-card"));
    const button = getComputedStyle(document.activeElement);
    return {
      buttonBackground: button.backgroundColor,
      buttonBorderWidth: Number.parseFloat(button.borderTopWidth),
      buttonColor: button.color,
      cardBorderStyle: card.borderTopStyle,
      cardBorderWidth: Number.parseFloat(card.borderTopWidth),
      forcedColors: matchMedia("(forced-colors: active)").matches,
      outlineStyle: button.outlineStyle,
      outlineWidth: Number.parseFloat(button.outlineWidth),
    };
  });
  expect(loginStructure.forcedColors).toBe(true);
  expect(loginStructure.buttonColor).not.toBe(loginStructure.buttonBackground);
  expect(loginStructure.buttonBorderWidth).toBeGreaterThanOrEqual(1);
  expect(loginStructure.cardBorderStyle).toBe("solid");
  expect(loginStructure.cardBorderWidth).toBeGreaterThanOrEqual(1);
  expect(loginStructure.outlineStyle).toBe("solid");
  expect(loginStructure.outlineWidth).toBeGreaterThanOrEqual(3);

  await signIn(page);
  await page.getByRole("button", { name: "Placements", exact: true }).click();
  await expect(page.locator(".status-pill").first()).toBeVisible();
  const changePassword = page.getByRole("button", { name: "Change password", exact: true });
  await changePassword.click();
  const dialog = page.getByRole("dialog", { name: "Change password", exact: true });
  await expect(dialog).toBeVisible();

  const workspaceStructure = await page.evaluate(() => {
    const card = getComputedStyle(document.querySelector(".workspace-card"));
    const current = getComputedStyle(
      document.querySelector('.workspace-sidebar nav button[aria-current="page"]'),
    );
    const dialogCard = getComputedStyle(document.querySelector(".modal-card"));
    const status = getComputedStyle(document.querySelector(".status-pill"));
    return {
      cardBorderWidth: Number.parseFloat(card.borderTopWidth),
      currentBackground: current.backgroundColor,
      currentColor: current.color,
      dialogBorderStyle: dialogCard.borderTopStyle,
      dialogBorderWidth: Number.parseFloat(dialogCard.borderTopWidth),
      statusBorderStyle: status.borderTopStyle,
      statusBorderWidth: Number.parseFloat(status.borderTopWidth),
    };
  });

  expect(workspaceStructure.cardBorderWidth).toBeGreaterThanOrEqual(1);
  expect(workspaceStructure.currentColor).not.toBe(workspaceStructure.currentBackground);
  expect(workspaceStructure.statusBorderStyle).toBe("solid");
  expect(workspaceStructure.statusBorderWidth).toBeGreaterThanOrEqual(1);
  expect(workspaceStructure.dialogBorderStyle).toBe("solid");
  expect(workspaceStructure.dialogBorderWidth).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("signs in to the self-hosted workspace and records a verifiable time entry", async ({ page }) => {
  await signIn(page);
  await expect(page.locator(".metric")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Open attention inbox", exact: true })).toBeVisible();

  await openPlacement(page, "Noah Rossi");
  await page.getByRole("button", { name: "Add time entry", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Entry date").fill("2026-04-10");
  await dialog.getByLabel("Hours").fill("1.5");
  await dialog.getByLabel("Description").fill("E2E verification entry");
  await dialog.getByRole("button", { name: "Add time entry", exact: true }).click();
  await expect(page.getByText("Time entry added.", { exact: true })).toBeVisible();
  await expect(page.getByText("1.5 hours · Pending", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByText("Time entry verified.", { exact: true })).toBeVisible();
  await expect(page.getByText("1.5 hours · Verified", { exact: true })).toBeVisible();
});

test("routes role-scoped attention into persistent placement next actions", async ({ page }) => {
  test.slow();
  await signIn(page);
  await ensureUserViaUi(page, {
    email: TUTOR_EMAIL,
    displayName: "E2E Tutor",
    role: "tutor",
    temporaryPassword: TUTOR_TEMP_PASSWORD,
  });

  await openPlacement(page, "Jonas Weber");
  await page.getByRole("button", { name: "Edit placement", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("searchbox", { name: "School tutor", exact: true }).fill("E2E Tutor");
  const tutorResults = dialog.getByRole("combobox", { name: "Search school tutor results" });
  await expect(tutorResults.getByRole("option", { name: "E2E Tutor", exact: true })).toHaveCount(1);
  await tutorResults.selectOption({ label: "E2E Tutor" });
  await dialog.getByRole("button", { name: "Save placement", exact: true }).click();
  await expect(page.getByText("Placement updated.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signInAs(page, {
    email: TUTOR_EMAIL,
    temporaryPassword: TUTOR_TEMP_PASSWORD,
    permanentPassword: TUTOR_PASSWORD,
  });

  const overviewAttention = page.locator(".workspace-card").filter({
    has: page.getByText("Needs attention", { exact: true }),
  });
  await expect(overviewAttention).toHaveCount(1);
  await expect(overviewAttention.getByText("Needs attention", { exact: true })).toBeVisible();
  const overviewAttentionButton = overviewAttention.getByRole("button", {
    name: /^(?:Attention|Open attention inbox)$/i,
  });
  await expect(overviewAttentionButton).toHaveCount(1);
  await overviewAttentionButton.click();

  await expect(page.getByRole("heading", { name: "What needs attention.", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Attention", exact: true })).toHaveAttribute("aria-current", "page");
  let categoryFilter = page.getByLabel("Attention category filter", { exact: true });
  for (const category of ["Evidence", "Hours", "Status", "Assignment"]) {
    await expect(categoryFilter.getByRole("button", { name: category, exact: true })).toBeVisible();
  }
  await categoryFilter.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(categoryFilter.getByRole("button", { name: "Evidence", exact: true })).toHaveAttribute("aria-pressed", "true");
  await categoryFilter.getByRole("button", { name: "Status", exact: true }).click();
  await expect(categoryFilter.getByRole("button", { name: "Status", exact: true })).toHaveAttribute("aria-pressed", "true");

  const attentionRows = page.getByRole("row").filter({
    has: page.getByRole("button", { name: "Open placement", exact: true }),
  });
  await expect(attentionRows).toHaveCount(1);
  const jonasAttention = attentionRows.filter({ hasText: "Jonas Weber" });
  await expect(jonasAttention).toHaveCount(1);
  await expect(page.getByText("Noah Rossi", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Ines Meyer", { exact: true })).toHaveCount(0);
  const openTargets = jonasAttention.getByRole("button", { name: "Open placement", exact: true });
  await expect(openTargets).toHaveCount(1);
  await openTargets.focus();
  await expect(openTargets).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Jonas Weber", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add check-in", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("When").fill("2026-06-20T10:30");
  await dialog.getByLabel("Channel").selectOption("video");
  await dialog.getByLabel("Summary").fill("Attention follow-up");
  await dialog.getByLabel("Next action").fill("Confirm host review");
  await dialog.getByRole("button", { name: "Add check-in", exact: true }).click();

  await page.getByRole("button", { name: "Add document", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Document type").selectOption("completion_certificate");
  await dialog.getByLabel("Title").fill("Attention evidence");
  await dialog.getByLabel("Status").selectOption("draft");
  await dialog.getByLabel("Due date").fill("2026-06-20");
  await dialog.getByLabel("Reference").fill("E2E-ATTN-001");
  await dialog.getByRole("button", { name: "Add document", exact: true }).click();

  let checkIn = page.locator(".activity-item").filter({ hasText: "Attention follow-up" });
  let document = page.locator(".activity-item").filter({ hasText: "Attention evidence" });
  await expect(checkIn.getByText("Next action: Confirm host review", { exact: true })).toBeVisible();
  await expect(document.getByText("Due Jun 20, 2026", { exact: true })).toBeVisible();
  await expect(document.getByText("Reference: E2E-ATTN-001", { exact: true })).toBeVisible();

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: /^(?:Keep the next action visible\.|Know what needs attention next\.)$/ })).toBeVisible();
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What needs attention.", exact: true })).toBeVisible();
  categoryFilter = page.getByLabel("Attention category filter", { exact: true });
  await categoryFilter.getByRole("button", { name: "Status", exact: true }).click();
  const reloadedRow = page.getByRole("row").filter({
    has: page.getByRole("button", { name: "Open placement", exact: true }),
    hasText: "Jonas Weber",
  });
  await expect(reloadedRow).toHaveCount(1);
  await reloadedRow.getByRole("button", { name: "Open placement", exact: true }).click();

  checkIn = page.locator(".activity-item").filter({ hasText: "Attention follow-up" });
  document = page.locator(".activity-item").filter({ hasText: "Attention evidence" });
  await expect(checkIn.getByText("Next action: Confirm host review", { exact: true })).toBeVisible();
  await expect(document.getByText("Due Jun 20, 2026", { exact: true })).toBeVisible();
  await expect(document.getByText("Reference: E2E-ATTN-001", { exact: true })).toBeVisible();
});

test("shows structured CSV validation errors without enabling import", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Placements", exact: true }).click();
  await page.getByRole("button", { name: "Import CSV", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Record type").selectOption("students");
  const [templateDownload] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Download template", exact: true }).click(),
  ]);
  expect(templateDownload.suggestedFilename()).toBe("vector-students-import-template.csv");
  const templateText = await readFile(await templateDownload.path(), "utf8");
  expect(templateText.codePointAt(0)).toBe(0xfeff);
  expect(templateText.slice(1).trim()).toBe("externalRef,firstName,lastName,email,cohortName,cohortAcademicYear");
  await dialog.getByLabel("CSV file").setInputFiles({
    name: "invalid-students.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("externalRef,firstName,lastName\nE2E-INVALID,,Tester\n"),
  });
  await withExpectedHttpFailure(page, 422, async () => {
    const responsePromise = page.waitForResponse((response) => response.url().includes("/api/import/students?dryRun=true") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Check CSV", exact: true }).click();
    return responsePromise;
  });
  await expect(dialog.getByText(/CSV check failed\. row 2, firstName: required/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Import checked CSV", exact: true })).toBeDisabled();
});

test("publishes a programme policy and applies its defaults to a new placement", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Programmes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rules that stay with the placement." })).toBeVisible();
  await page.getByRole("button", { name: "New programme", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Programme code").fill("E2E_ENGINEERING");
  await dialog.getByLabel("Programme name").fill("E2E engineering pathway");
  await dialog.getByLabel("Default target hours").fill("24");
  await dialog.getByLabel("Minimum check-ins").fill("2");
  await dialog.getByLabel("Operational description").fill("A fictional browser acceptance policy.");
  await dialog.getByLabel("Requirements: code | label | accepted statuses").fill(
    "mentor_report | Mentor report | ready, signed, archived",
  );
  await dialog.getByRole("button", { name: "Create programme", exact: true }).click();
  await expect(page.getByText("Programme version 1 published.", { exact: true })).toBeVisible();
  const programmeRow = page.locator(".programme-row").filter({ hasText: "E2E_ENGINEERING" });
  await expect(programmeRow).toBeVisible();
  await programmeRow.getByRole("button", { name: "Version history", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "E2E engineering pathway · version history" })).toBeVisible();
  await expect(dialog.getByText("VERSION 1", { exact: true })).toBeVisible();
  await expect(dialog.getByText("24 default hours · 2 minimum check-ins", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole("button", { name: "Placements", exact: true }).click();
  await page.getByRole("button", { name: "New placement", exact: true }).click();
  dialog = page.getByRole("dialog");
  const programmeOption = dialog.getByLabel("Programme policy").locator("option")
    .filter({ hasText: "E2E engineering pathway" });
  await dialog.getByLabel("Programme policy").selectOption(
    await programmeOption.getAttribute("value"),
  );
  await expect(dialog.getByLabel("Target hours")).toHaveValue("24");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("reports a programme-history outage without an unhandled browser rejection", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Programmes", exact: true }).click();
  const programmeRow = page.locator(".programme-row").first();
  await expect(programmeRow).toBeVisible();
  await page.route(
    (url) => /\/api\/programmes\/[^/]+\/versions$/.test(url.pathname),
    async (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "programme_history_unavailable",
          message: "Synthetic programme history outage.",
        },
      }),
    }),
  );

  await withExpectedHttpFailure(page, 503, async () => {
    await programmeRow.getByRole("button", { name: "Version history", exact: true }).click();
    await expect(page.getByText("Synthetic programme history outage.", { exact: true }))
      .toBeVisible();
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("uses revisions for user edits and password resets, and refreshes stale forms", async ({ page }) => {
  await signIn(page);
  await ensureUserViaUi(page, { email: VIEWER_EMAIL, displayName: "E2E Viewer", role: "viewer", temporaryPassword: VIEWER_TEMP_PASSWORD });
  await ensureUserViaUi(page, { email: TUTOR_EMAIL, displayName: "E2E Tutor", role: "tutor", temporaryPassword: TUTOR_TEMP_PASSWORD });

  let viewerRow = page.locator(".user-row").filter({ hasText: VIEWER_EMAIL });
  await viewerRow.getByRole("button", { name: "Edit", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Display name").fill("E2E Viewer Edited");
  await dialog.getByRole("button", { name: "Save user", exact: true }).click();
  await expect(page.getByText("User updated.", { exact: true })).toBeVisible();
  await expect(page.locator(".user-row").filter({ hasText: "E2E Viewer Edited" })).toBeVisible();

  const currentViewer = await page.evaluate(async (email) => {
    const payload = await fetch("/api/users", { headers: { Accept: "application/json" } }).then((response) => response.json());
    return payload.items.find((user) => user.email === email);
  }, VIEWER_EMAIL);
  viewerRow = page.locator(".user-row").filter({ hasText: VIEWER_EMAIL });
  await viewerRow.getByRole("button", { name: "Edit", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Display name").fill("Stale browser edit");
  const externalStatus = await page.evaluate(async ({ user }) => {
    const session = await fetch("/api/session", { headers: { Accept: "application/json" } }).then((response) => response.json());
    const response = await fetch(`/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": session.csrfToken },
      body: JSON.stringify({ revision: user.revision, displayName: "E2E Viewer Server Update" }),
    });
    return response.status;
  }, { user: currentViewer });
  expect(externalStatus).toBe(200);
  const staleResponse = await withExpectedHttpFailure(page, 409, async () => {
    const responsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/users/${currentViewer.id}`) && response.request().method() === "PATCH");
    await dialog.getByRole("button", { name: "Save user", exact: true }).click();
    return responsePromise;
  });
  expect(staleResponse.status()).toBe(409);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("This account changed in another session. The user list has been refreshed; review it before trying again.", { exact: true })).toBeVisible();
  await expect(page.locator(".user-row").filter({ hasText: "E2E Viewer Server Update" })).toBeVisible();

  viewerRow = page.locator(".user-row").filter({ hasText: VIEWER_EMAIL });
  await viewerRow.getByRole("button", { name: "Reset password", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("New temporary password").fill(VIEWER_RESET_PASSWORD);
  await dialog.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.getByText("Password reset. The user must replace this temporary password at the next sign-in.", { exact: true })).toBeVisible();

  await openPlacement(page, "Noah Rossi");
  await page.getByRole("button", { name: "Edit placement", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("searchbox", { name: "School tutor", exact: true }).fill("E2E Tutor");
  const tutorResults = dialog.getByRole("combobox", { name: "Search school tutor results" });
  await expect(tutorResults.getByRole("option", { name: "E2E Tutor", exact: true })).toHaveCount(1);
  await tutorResults.selectOption({ label: "E2E Tutor" });
  await expect(tutorResults).toHaveValue(/.+/);
  await dialog.getByRole("button", { name: "Save placement", exact: true }).click();
  await expect(page.getByText("Placement updated.", { exact: true })).toBeVisible();
});

test("renders viewer and assigned tutor actions from role capabilities", async ({ page }) => {
  await signInAs(page, { email: VIEWER_EMAIL, temporaryPassword: VIEWER_RESET_PASSWORD, permanentPassword: VIEWER_PASSWORD });
  await expect(page.getByRole("button", { name: "Audit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Coverage", exact: true })).toBeVisible();
  await openPlacement(page, "Noah Rossi");
  await expect(page.getByRole("button", { name: /Add time entry|Add check-in|Add document|Update status|Reopen placement|Edit placement|Verify|Reject|Void|Archive|Supersede/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to the workspace." })).toBeVisible();
  await signInAs(page, { email: TUTOR_EMAIL, temporaryPassword: TUTOR_TEMP_PASSWORD, permanentPassword: TUTOR_PASSWORD });
  await expect(page.getByRole("button", { name: "Audit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Coverage", exact: true })).toHaveCount(0);
  await openPlacement(page, "Noah Rossi");
  await expect(page.getByRole("button", { name: "Add time entry", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add check-in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add document", exact: true })).toBeVisible();

  await expect(page.getByRole("button", { name: /Update status|Reopen placement|Edit placement|Verify|Reject|Void|Archive|Supersede/ })).toHaveCount(0);
});

test("clears stale coverage results when a filter refresh fails and recovers", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Coverage", exact: true }).click();
  await expect(page.locator('tr[data-student-id="student-maya"]')).toBeVisible();

  let failNextCoverageRequest = true;
  await page.route(
    (url) => url.pathname.endsWith("/api/coverage"),
    async (route) => {
      if (!failNextCoverageRequest) {
        await route.continue();
        return;
      }
      failNextCoverageRequest = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "coverage_unavailable",
            message: "Synthetic coverage outage.",
          },
        }),
      });
    },
  );

  await withExpectedHttpFailure(page, 503, async () => {
    await page.getByLabel("Cohort", { exact: true }).selectOption("cohort-systems");
    await expect(page.getByText("Coverage could not be loaded.", { exact: true })).toBeVisible();
  });
  await expect(page.locator('tr[data-student-id="student-maya"]')).toHaveCount(0);
  await expect(page.locator(".coverage-table")).toHaveCount(0);
  await expect(page.locator('[data-coverage-metrics="true"] .metric strong')).toHaveText(["0", "0", "0", "0"]);

  await page.getByRole("button", { name: "Retry coverage refresh", exact: true }).click();
  await expect(page.locator('tr[data-student-id="student-ines"]')).toBeVisible();
  await expect(page.getByText("Coverage could not be loaded.", { exact: true })).toHaveCount(0);
});

test("clears authenticated list and Coverage state between browser sessions", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Students", exact: true }).click();
  const studentFilterResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith("/api/students")
      && url.searchParams.get("query") === "SESSION-STUDENT-MARKER";
  });
  await page.getByRole("searchbox", { name: "Search students", exact: true })
    .fill("SESSION-STUDENT-MARKER");
  await studentFilterResponse;
  await page.getByRole("button", { name: "Coverage", exact: true }).click();

  const cohortResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith("/api/coverage")
      && url.searchParams.get("cohortId") === "cohort-systems";
  });
  await page.getByLabel("Cohort", { exact: true }).selectOption("cohort-systems");
  await cohortResponse;

  const queryResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith("/api/coverage")
      && url.searchParams.get("query") === "SESSION-LEAK-MARKER";
  });
  await page.getByRole("searchbox", { name: "Search cohort coverage", exact: true }).fill("SESSION-LEAK-MARKER");
  await queryResponse;

  const conflictResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith("/api/coverage")
      && url.searchParams.get("status") === "conflict";
  });
  await page.locator('[aria-label="Coverage status filter"]').getByRole("button", { name: "Conflicts", exact: true }).click();
  await conflictResponse;

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to the workspace." })).toBeVisible();
  const cleanCoverageRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname.endsWith("/api/coverage");
  });
  const cleanStudentRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname.endsWith("/api/students");
  });
  const loginResponse = await submitLogin(page, E2E_PASSWORD);
  expect(loginResponse.ok()).toBeTruthy();
  const [cleanRequest, cleanStudent] = await Promise.all([
    cleanCoverageRequest,
    cleanStudentRequest,
  ]);
  await expect(page.getByRole("heading", { name: "Know what needs attention next." })).toBeVisible();

  const cleanUrl = new URL(cleanRequest.url());
  expect(cleanUrl.searchParams.get("query")).toBe("");
  expect(cleanUrl.searchParams.get("status")).toBe("all");
  expect(cleanUrl.searchParams.get("cohortId")).toBe("cohort-software");
  expect(cleanUrl.searchParams.get("periodId")).toBe("period-spring-2026");
  const cleanStudentUrl = new URL(cleanStudent.url());
  expect(cleanStudentUrl.searchParams.get("query")).toBe("");
  expect(cleanStudentUrl.searchParams.get("active")).toBe("all");

  await page.getByRole("button", { name: "Coverage", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search cohort coverage", exact: true })).toHaveValue("");
  await expect(page.locator('[aria-label="Coverage status filter"]').getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Cohort", { exact: true })).toHaveValue("cohort-software");
  await page.getByRole("button", { name: "Students", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search students", exact: true }))
    .toHaveValue("");
});

test("clears authenticated notifications at the sign-out boundary", async ({ page }) => {
  await signIn(page);
  await expect(page.getByText("Signed in.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Sign out", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Sign in to the workspace." })).toBeVisible();
  await expect(page.getByText("Signed in.", { exact: true })).toHaveCount(0);
});

test("loads every active Coverage reference beyond the first 100 records", async ({ page }) => {
  const cohortPage = [
    {
      id: "cohort-software",
      name: "4A Software",
      academicYear: "2025/2026",
      track: "Software",
      tutorUserId: null,
      active: true,
      revision: 1,
    },
    ...Array.from({ length: 99 }, (_, index) => ({
      id: `coverage-cohort-${index}`,
      name: `Coverage cohort ${String(index).padStart(2, "0")}`,
      academicYear: "2026/2027",
      track: "",
      tutorUserId: null,
      active: true,
      revision: 1,
    })),
  ];
  const periodPage = [
    {
      id: "period-spring-2026",
      name: "Spring 2026",
      startDate: "2026-03-02",
      endDate: "2026-06-26",
      active: true,
      revision: 1,
    },
    ...Array.from({ length: 99 }, (_, index) => ({
      id: `coverage-period-${index}`,
      name: `Coverage period ${String(index).padStart(2, "0")}`,
      startDate: "2027-01-01",
      endDate: "2027-01-31",
      active: true,
      revision: 1,
    })),
  ];
  const overflowCohort = {
    id: "coverage-overflow-cohort",
    name: "Overflow cohort",
    academicYear: "2027/2028",
    track: "Overflow",
    tutorUserId: null,
    active: true,
    revision: 1,
  };
  const overflowPeriod = {
    id: "coverage-overflow-period",
    name: "Overflow period",
    startDate: "2027-07-01",
    endDate: "2027-07-31",
    active: true,
    revision: 1,
  };
  const activeReferenceUrls = [];
  await page.route(
    (url) => url.pathname.includes("/api/reference-data/"),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("active") !== "true") {
        await route.continue();
        return;
      }
      activeReferenceUrls.push(url);
      const cohorts = url.pathname.endsWith("/cohorts");
      const expectedCursor = cohorts ? "coverage-cohort-page-2" : "coverage-period-page-2";
      const cursor = url.searchParams.get("cursor");
      const items = cursor === expectedCursor
        ? [cohorts ? overflowCohort : overflowPeriod]
        : cohorts ? cohortPage : periodPage;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items,
          nextCursor: cursor ? null : expectedCursor,
        }),
      });
    },
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/coverage"),
    async (route) => {
      const url = new URL(route.request().url());
      const overflowSelected = url.searchParams.get("cohortId") === overflowCohort.id
        && url.searchParams.get("periodId") === overflowPeriod.id;
      const usesMockReference = url.searchParams.get("cohortId") === overflowCohort.id
        || url.searchParams.get("periodId") === overflowPeriod.id;
      if (!usesMockReference) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          summary: {
            total: overflowSelected ? 1 : 0,
            unplaced: overflowSelected ? 1 : 0,
            placed: 0,
            conflict: 0,
          },
          items: overflowSelected ? [{
            studentId: "coverage-overflow-student",
            studentName: "Overflow Student",
            externalRef: "OVERFLOW-101",
            cohortId: overflowCohort.id,
            cohortName: overflowCohort.name,
            status: "unplaced",
            placementCount: 0,
            placements: [],
            additionalPlacements: 0,
          }] : [],
          nextCursor: null,
        }),
      });
    },
  );

  await signIn(page);
  await page.getByRole("button", { name: "Coverage", exact: true }).click();
  const cohort = page.getByLabel("Cohort", { exact: true });
  const period = page.getByLabel("Placement period", { exact: true });
  await expect(cohort.locator(`option[value="${overflowCohort.id}"]`)).toBeAttached();
  await expect(period.locator(`option[value="${overflowPeriod.id}"]`)).toBeAttached();
  await expect(cohort.locator("option")).toHaveCount(102);
  await expect(period.locator("option")).toHaveCount(102);
  const cursorRequests = activeReferenceUrls.filter((url) => url.searchParams.has("cursor"));
  expect(cursorRequests).toHaveLength(2);
  expect(cursorRequests.every((url) => url.searchParams.get("active") === "true" && url.searchParams.get("limit") === "100")).toBeTruthy();

  await cohort.selectOption(overflowCohort.id);
  await period.selectOption(overflowPeriod.id);
  const overflowRow = page.locator('tr[data-student-id="coverage-overflow-student"]');
  await expect(overflowRow).toBeVisible();
  await overflowRow.getByRole("button", { name: "Create placement for Overflow Student", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('select[aria-label="Search placement period results"]')).toHaveValue(overflowPeriod.id);
  await expect(dialog.getByLabel("Start date")).toHaveValue(overflowPeriod.startDate);
  await expect(dialog.getByLabel("End date")).toHaveValue(overflowPeriod.endDate);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
});

test("gives same-host placement actions unique date-aware accessible names", async ({ page }) => {
  await page.route(
    (url) => url.pathname.endsWith("/api/coverage"),
    async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          summary: { total: 1, unplaced: 0, placed: 1, conflict: 0 },
          items: [{
            studentId: "duplicate-actions",
            studentName: "Duplicate Actions",
            externalRef: "DUPLICATE-ACTIONS",
            cohortId: url.searchParams.get("cohortId"),
            cohortName: "4A Software",
            status: "placed",
            placementCount: 2,
            placements: [
              {
                id: "duplicate-placement-one",
                hostName: "Same Host",
                status: "planned",
                startDate: "2026-03-02",
                endDate: "2026-03-31",
              },
              {
                id: "duplicate-placement-two",
                hostName: "Same Host",
                status: "active",
                startDate: "2026-04-01",
                endDate: "2026-04-30",
              },
            ],
            additionalPlacements: 0,
          }],
          nextCursor: null,
        }),
      });
    },
  );

  await signIn(page);
  await page.getByRole("button", { name: "Coverage", exact: true }).click();
  const buttons = page.locator('tr[data-student-id="duplicate-actions"] .coverage-actions > button');
  await expect(buttons).toHaveCount(2);
  const labels = await buttons.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  expect(labels.every(Boolean)).toBeTruthy();
  expect(new Set(labels).size).toBe(2);
  expect(labels[0]).toContain("Mar 02, 2026 to Mar 31, 2026");
  expect(labels[1]).toContain("Apr 01, 2026 to Apr 30, 2026");
});

test("plans cohort coverage and creates a prefilled placement from a gap", async ({ page }) => {
  test.setTimeout(30_000);
  await signIn(page);

  await page.getByRole("button", { name: "Students", exact: true }).click();
  await page.getByRole("button", { name: "New student", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("First name").fill("Coverage");
  await dialog.getByLabel("Last name").fill("Candidate");
  await dialog.getByLabel("External reference").fill("COVERAGE-E2E");
  const cohortResults = dialog.locator('select[aria-label="Search cohort results"]');
  await expect(cohortResults.locator('option[value="cohort-software"]')).toBeAttached();
  await cohortResults.selectOption("cohort-software");
  await dialog.getByRole("button", { name: "Create student", exact: true }).click();
  await expect(page.getByText("Student created.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Coverage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Every student, accounted for." })).toBeVisible();
  await expect(page.getByLabel("Cohort", { exact: true })).toHaveValue("cohort-software");
  await expect(page.getByLabel("Placement period", { exact: true })).toHaveValue("period-spring-2026");

  const coverageSearch = page.getByRole("searchbox", { name: "Search cohort coverage", exact: true });
  await coverageSearch.fill("Coverage Candidate");
  await page.getByRole("button", { name: "Unplaced", exact: true }).click();
  const uncoveredRow = page.locator(".coverage-table tbody tr").filter({ hasText: "Coverage Candidate" });
  await expect(uncoveredRow).toHaveCount(1);
  await expect(uncoveredRow).toContainText("Unplaced");
  const unplacedMetric = page.locator('[data-coverage-metrics="true"] .metric').filter({ hasText: "Unplaced" });
  await expect(unplacedMetric.locator("strong")).toHaveText("1");

  await uncoveredRow.getByRole("button", { name: "Create placement for Coverage Candidate", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.locator('select[aria-label="Search student results"]')).toHaveValue(/.+/);
  await expect(dialog.locator('select[aria-label="Search student results"] option:checked')).toContainText("Coverage Candidate");
  await expect(dialog.locator('select[aria-label="Search placement period results"]')).toHaveValue("period-spring-2026");
  await expect(dialog.getByLabel("Start date")).toHaveValue("2026-03-02");
  await expect(dialog.getByLabel("End date")).toHaveValue("2026-06-26");
  const hostResults = dialog.locator('select[aria-label="Search host results"]');
  await expect(hostResults.locator('option[value="host-atlas"]')).toBeAttached();
  await hostResults.selectOption("host-atlas");

  let placementCreateRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/api/placements") && request.method() === "POST") {
      placementCreateRequests += 1;
    }
  });
  let failCoverageRefresh = true;
  await page.route(
    (url) => url.pathname.endsWith("/api/coverage"),
    async (route) => {
      if (!failCoverageRefresh) {
        await route.continue();
        return;
      }
      failCoverageRefresh = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "coverage_unavailable",
            message: "Synthetic coverage refresh failure.",
          },
        }),
      });
    },
  );
  await withExpectedHttpFailure(page, 503, async () => {
    await dialog.getByRole("button", { name: "Create placement", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Coverage could not be loaded.", { exact: true })).toBeVisible();
  });

  await expect(page.getByText("Placement created.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Every student, accounted for." })).toBeVisible();
  await expect(page.getByText(/placement was created, but Coverage could not be refreshed/i)).toBeVisible();
  expect(placementCreateRequests).toBe(1);

  await page.getByRole("button", { name: "Retry coverage refresh", exact: true }).click();
  await expect(page.getByText("No students match this coverage view.", { exact: true })).toBeVisible();
  expect(placementCreateRequests).toBe(1);
  await page.getByRole("button", { name: "All", exact: true }).click();
  const coveredRow = page.locator(".coverage-table tbody tr").filter({ hasText: "Coverage Candidate" });
  await expect(coveredRow).toHaveCount(1);
  await expect(coveredRow).toContainText("Placed");
  await coveredRow.getByRole("button", {
    name: /Open placement 1 of 1 for Coverage Candidate at Atlas Workshop, .+ to .+/,
  }).click();
  await expect(page.getByRole("heading", { name: "Coverage Candidate", exact: true })).toBeVisible();
  await expect(page.getByText("Atlas Workshop", { exact: true }).first()).toBeVisible();
});

test.describe("mobile workspace", () => {
  test.use({ viewport: { width: 320, height: 800 }, hasTouch: true, isMobile: true });

  test("keeps a completed placement read-only and within the mobile viewport", async ({ page }) => {
    await signIn(page);
    await openPlacement(page, "Lea Dubois");
    await expect(page.getByText("This completed record is locked. A school administrator may reopen it for a coded correction.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reopen placement", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Add time entry|Add check-in|Add document|Update status|Verify|Edit placement/ })).toHaveCount(0);
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
  });
});

test("keeps the signed-in session after a wrong current password", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Current password", { exact: true }).fill("wrong-current-password");
  await dialog.getByLabel("New password", { exact: true }).fill("vector-e2e-another-password-2026");
  await dialog.getByLabel("Confirm new password", { exact: true }).fill("vector-e2e-another-password-2026");
  const response = await withExpectedHttpFailure(page, 422, async () => {
    const responsePromise = page.waitForResponse((result) => result.url().endsWith("/api/auth/change-password") && result.request().method() === "POST");
    await dialog.getByRole("button", { name: "Change password", exact: true }).click();
    return responsePromise;
  });
  expect(response.status()).toBe(422);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Change password", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("heading", { name: /^(?:Keep the next action visible\.|Know what needs attention next\.)$/ })).toBeVisible();
  await page.getByRole("button", { name: "Placements", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Every placement, in context." })).toBeVisible();
});

test("recovers an expired session from an open dialog without trapping focus", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change password", exact: true });
  await expect(dialog).toBeVisible();

  const logoutStatus = await page.evaluate(async () => {
    const session = await fetch("/api/session", {
      cache: "no-store",
      credentials: "same-origin",
    }).then((response) => response.json());
    const response = await fetch("/api/auth/logout", {
      body: "{}",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrfToken,
      },
      method: "POST",
    });
    return response.status;
  });
  expect(logoutStatus).toBe(200);

  await dialog.getByLabel("Current password").fill(E2E_PASSWORD);
  await dialog.getByLabel("New password", { exact: true }).fill("unused-new-password-2026");
  await dialog.getByLabel("Confirm new password", { exact: true }).fill("unused-new-password-2026");
  const rejected = await withExpectedHttpFailure(page, 401, async () => {
    const response = page.waitForResponse((candidate) => (
      candidate.url().endsWith("/api/auth/change-password")
      && candidate.request().method() === "POST"
    ));
    await dialog.getByRole("button", { name: "Change password", exact: true }).click();
    return response;
  });
  expect(rejected.status()).toBe(401);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#app")).toHaveJSProperty("inert", false);
  await expect(page.getByRole("heading", { name: "Sign in to the workspace." })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeFocused();
  await expect(page.getByText("Your session ended. Sign in to continue.", { exact: true }))
    .toHaveCount(1);
  await expect(page.getByText("Sign in to continue.", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Skip to workspace", exact: true }),
  ).toBeHidden();
});


test("corrects operational evidence and governs signed and completed records", async ({ page }) => {
  await signIn(page);
  await openPlacement(page, "Noah Rossi");

  await page.getByRole("button", { name: "Add time entry", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Entry date").fill("2026-04-21");
  await dialog.getByLabel("Hours").fill("2");
  await dialog.getByLabel("Description").fill("Lifecycle correction entry");
  await dialog.getByRole("button", { name: "Add time entry", exact: true }).click();
  let activity = page.locator(".activity-item").filter({ hasText: "Lifecycle correction entry" });
  await activity.getByRole("button", { name: "Edit", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Hours").fill("2.25");
  await dialog.getByLabel("Description").fill("Lifecycle entry corrected after review");
  await dialog.getByLabel("Review status").selectOption("rejected");
  await dialog.getByRole("button", { name: "Save time entry", exact: true }).click();
  activity = page.locator(".activity-item").filter({ hasText: "Lifecycle entry corrected after review" });
  await expect(activity.getByText("2.25 hours · Rejected", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add check-in", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("When").fill("2026-04-22T10:30");
  await dialog.getByLabel("Channel").selectOption("video");
  await dialog.getByLabel("Summary").fill("Lifecycle check-in");
  await dialog.getByLabel("Next action").fill("Correct the record");
  await dialog.getByRole("button", { name: "Add check-in", exact: true }).click();
  activity = page.locator(".activity-item").filter({ hasText: "Lifecycle check-in" });
  await activity.getByRole("button", { name: "Edit", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Summary").fill("Lifecycle check-in corrected");
  await dialog.getByRole("button", { name: "Save check-in", exact: true }).click();
  activity = page.locator(".activity-item").filter({ hasText: "Lifecycle check-in corrected" });
  await activity.getByRole("button", { name: "Void", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason for voiding").fill("Duplicate contact record entered during verification.");
  await dialog.getByRole("button", { name: "Void check-in", exact: true }).click();
  activity = page.locator(".activity-item").filter({ hasText: "Lifecycle check-in corrected" });
  await expect(activity.getByText("Video · Voided", { exact: true })).toBeVisible();
  await expect(activity.getByText("Void reason: Duplicate contact record entered during verification.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add document", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Document type").selectOption("other");
  await dialog.getByLabel("Title").fill("Signed lifecycle evidence");
  await dialog.getByLabel("Status").selectOption("signed");
  await dialog.getByLabel("Reference").fill("E2E-DOC-001");
  await dialog.getByRole("button", { name: "Add document", exact: true }).click();
  activity = page.locator(".activity-item").filter({ hasText: "Signed lifecycle evidence" });
  await activity.getByRole("button", { name: "Supersede", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").selectOption("incorrect_evidence");
  await dialog.getByLabel("Replacement title").fill("Corrected lifecycle evidence");
  await dialog.getByLabel("Initial status").selectOption("ready");
  await dialog.getByLabel("Reference").fill("E2E-DOC-002");
  await dialog.getByRole("button", { name: "Create replacement", exact: true }).click();
  await expect(page.locator(".activity-item").filter({ hasText: "Signed lifecycle evidence · Superseded" })).toBeVisible();
  await expect(page.locator(".activity-item").filter({ hasText: "Corrected lifecycle evidence" })).toBeVisible();

  await page.getByRole("button", { name: "← All placements", exact: true }).click();
  const completed = page.locator(".data-table tbody tr").filter({ hasText: "Lea Dubois" });
  await completed.getByRole("button", { name: "Open" }).click();
  await page.getByRole("button", { name: "Reopen placement", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Correction reason").selectOption("administrative_correction");
  await dialog.getByRole("button", { name: "Reopen for review", exact: true }).click();
  await expect(page.getByText("Placement reopened in review.", { exact: true })).toBeVisible();
  await expect(page.getByText("Review", { exact: true })).toBeVisible();
});


test("saves versioned branding and rejects a time zone that invalidates activity", async ({ page }) => {
  await signIn(page);
  await openPlacement(page, "Noah Rossi");
  await page.getByRole("button", { name: "Add check-in", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("When").fill("2026-03-02T01:30");
  await dialog.getByLabel("Channel").selectOption("in_person");
  await dialog.getByLabel("Summary").fill("Time-zone boundary check-in");
  await dialog.getByRole("button", { name: "Add check-in", exact: true }).click();
  await expect(page.locator(".activity-item").filter({ hasText: "Time-zone boundary check-in" })).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Contact text").fill("Placement support · E2E verified");
  await page.getByRole("button", { name: "Save branding", exact: true }).click();
  await expect(page.getByText("Branding saved.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Contact text")).toHaveValue("Placement support · E2E verified");

  await page.getByLabel("IANA time zone").fill("America/Los_Angeles");
  const rejected = await withExpectedHttpFailure(page, 422, async () => {
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/branding") && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save branding", exact: true }).click();
    return responsePromise;
  });
  expect(rejected.status()).toBe(422);
  await expect(page.getByText("The selected time zone would move recorded check-ins outside their placement dates.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save branding", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Placements", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Every placement, in context." })).toBeVisible();
});


test("reconciles stale logo uploads and removals with strong branding revisions", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const mutateBrandingExternally = () => page.evaluate(async () => {
    const [session, branding] = await Promise.all([
      fetch("/api/session", { headers: { Accept: "application/json" } }).then((response) => response.json()),
      fetch("/api/public/branding", { headers: { Accept: "application/json" } }).then((response) => response.json()),
    ]);
    const response = await fetch("/api/branding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": session.csrfToken },
      body: JSON.stringify({
        revision: branding.revision,
        schoolName: branding.schoolName,
        shortName: branding.shortName,
        productName: branding.productName,
        timeZone: branding.timeZone,
        primaryColor: branding.primaryColor,
        accentColor: branding.accentColor,
        surfaceColor: branding.surfaceColor,
        supportEmail: branding.supportEmail,
        contactText: branding.contactText === "Logo concurrency A" ? "Logo concurrency B" : "Logo concurrency A",
        footerText: branding.footerText,
      }),
    });
    return response.status;
  });
  const chooseLogo = () => page.locator('input[type="file"][accept="image/png"]').setInputFiles("site/assets/social-preview.png");

  expect(await mutateBrandingExternally()).toBe(200);
  await chooseLogo();
  const staleUpload = await withExpectedHttpFailure(page, 409, async () => {
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/branding/logo") && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Upload PNG logo", exact: true }).click();
    return responsePromise;
  });
  expect(staleUpload.status()).toBe(409);
  await expect(page.getByText("Branding changed in another session. The latest logo settings are now loaded.", { exact: true }).last()).toBeVisible();

  await chooseLogo();
  const uploadPromise = page.waitForResponse((response) => response.url().endsWith("/api/branding/logo") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Upload PNG logo", exact: true }).click();
  expect((await uploadPromise).status()).toBe(200);
  await expect(page.getByText("Runtime logo uploaded.", { exact: true })).toBeVisible();
  await expect(page.getByText("A runtime PNG logo is active.", { exact: true })).toBeVisible();

  expect(await mutateBrandingExternally()).toBe(200);
  const staleRemoval = await withExpectedHttpFailure(page, 409, async () => {
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/branding/logo") && response.request().method() === "DELETE");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Remove logo", exact: true }).click();
    return responsePromise;
  });
  expect(staleRemoval.status()).toBe(409);
  await expect(page.getByText("Branding changed in another session. The latest logo settings are now loaded.", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("A runtime PNG logo is active.", { exact: true })).toBeVisible();

  const removalPromise = page.waitForResponse((response) => response.url().endsWith("/api/branding/logo") && response.request().method() === "DELETE");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove logo", exact: true }).click();
  expect((await removalPromise).status()).toBe(200);
  await expect(page.getByText("Runtime logo removed.", { exact: true })).toBeVisible();
  await expect(page.getByText("The default VECTOR mark is active.", { exact: true })).toBeVisible();
});

test("keeps the main registers paged, race-safe and aligned with filtered exports", async ({ page }) => {
  const numbers = Array.from({ length: 55 }, (_, index) => index + 1);
  const pad = (value) => String(value).padStart(3, "0");
  const placements = numbers.map((number) => ({
    id: `fixture-placement-${pad(number)}`,
    studentName: `Fixture Placement ${pad(number)}`,
    cohortName: "Fixture Cohort",
    hostName: `Fixture Placement Host ${pad(number)}`,
    schoolTutorName: "Fixture Tutor",
    startDate: "2026-03-02",
    endDate: "2026-06-26",
    status: number % 2 === 1 ? "active" : "review",
    loggedHours: number,
    targetHours: 100,
    documentGaps: number % 3 === 0 ? 1 : 0,
  }));
  const students = numbers.map((number) => ({
    id: `fixture-student-${pad(number)}`,
    firstName: "Fixture",
    lastName: `Student ${pad(number)}`,
    externalRef: `STU-${pad(number)}`,
    email: `student-${pad(number)}@example.test`,
    cohortName: "Fixture Cohort",
    active: number % 2 === 0,
    retentionHold: false,
    revision: 1,
  }));
  const hosts = numbers.map((number) => ({
    id: `fixture-host-${pad(number)}`,
    name: `Fixture Host ${pad(number)}`,
    sector: `Sector ${number % 4}`,
    contactName: `Contact ${pad(number)}`,
    contactEmail: `host-${pad(number)}@example.test`,
    active: number % 2 === 0,
    revision: 1,
  }));
  const requests = [];
  let settleSlowHost;
  const slowHostSettled = new Promise((resolve) => { settleSlowHost = resolve; });

  const pageFixture = async (route, resource, source, matcher) => {
    const url = new URL(route.request().url());
    const query = (url.searchParams.get("query") || "").toLowerCase();
    const status = url.searchParams.get("status") || "all";
    const active = url.searchParams.get("active") || "all";
    const limit = Number(url.searchParams.get("limit") || 50);
    const cursor = url.searchParams.get("cursor");
    const offset = cursor ? Number(cursor.replace("fixture-cursor-", "")) : 0;
    requests.push({ resource, query, status, active, limit, cursor });
    const filtered = source.filter((item) => matcher(item, { query, status, active }));
    const items = filtered.slice(offset, offset + limit);
    const nextCursor = offset + limit < filtered.length ? `fixture-cursor-${offset + limit}` : null;
    if (resource === "hosts" && query === "slow host") await new Promise((resolve) => setTimeout(resolve, 650));
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items, nextCursor }),
      });
    } catch (error) {
      if (!(resource === "hosts" && query === "slow host")) throw error;
    } finally {
      if (resource === "hosts" && query === "slow host") settleSlowHost();
    }
  };

  await page.route(/\/api\/placements\?/, (route) => pageFixture(route, "placements", placements, (item, filters) => {
    const matchesQuery = !filters.query || `${item.studentName} ${item.hostName} ${item.schoolTutorName}`.toLowerCase().includes(filters.query);
    return matchesQuery && (filters.status === "all" || item.status === filters.status);
  }));
  await page.route(/\/api\/students\?/, (route) => pageFixture(route, "students", students, (item, filters) => {
    const matchesQuery = !filters.query || `${item.firstName} ${item.lastName} ${item.externalRef} ${item.email} ${item.cohortName}`.toLowerCase().includes(filters.query);
    return matchesQuery && (filters.active === "all" || String(item.active) === filters.active);
  }));
  await page.route(/\/api\/hosts\?/, (route) => pageFixture(route, "hosts", hosts, (item, filters) => {
    const matchesQuery = !filters.query || `${item.name} ${item.sector} ${item.contactName} ${item.contactEmail}`.toLowerCase().includes(filters.query);
    return matchesQuery && (filters.active === "all" || String(item.active) === filters.active);
  }));
  const lookupRequests = [];
  await page.route(/\/api\/lookups\/hosts\?/, async (route) => {
    const url = new URL(route.request().url());
    const query = (url.searchParams.get("query") || "").toLowerCase();
    const limit = Number(url.searchParams.get("limit") || 20);
    lookupRequests.push({ query, limit });
    const matches = hosts.filter((host) => host.active && (!query || `${host.name} ${host.sector}`.toLowerCase().includes(query)));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: matches.slice(0, limit).map((host) => ({ id: host.id, label: host.name, secondary: host.sector })),
        nextCursor: matches.length > limit ? "fixture-lookup-cursor" : null,
      }),
    });
  });

  const waitForCollection = (resource, predicate) => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/${resource}` && response.request().method() === "GET" && predicate(url.searchParams);
  });
  const expectExport = async (resource, expected) => {
    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/export" && url.searchParams.get("resource") === resource;
    });
    await page.getByRole("button", { name: "Export current CSV", exact: true }).click();
    const response = await responsePromise;
    expect(response.ok()).toBeTruthy();
    const params = new URL(response.url()).searchParams;
    Object.entries(expected).forEach(([name, value]) => expect(params.get(name)).toBe(value));
  };
  const rows = () => page.locator(".workspace-card .data-table tbody tr");

  await signIn(page);

  await page.getByRole("button", { name: "Placements", exact: true }).click();
  await expect(rows()).toHaveCount(50);
  const placementSearch = page.getByRole("searchbox", { name: "Search placements", exact: true });
  let responsePromise = waitForCollection("placements", (params) => params.get("query") === "Fixture Placement 055" && params.get("status") === "all");
  await placementSearch.fill("Fixture Placement 055");
  await responsePromise;
  await expect(placementSearch).toBeFocused();
  await expect(rows()).toHaveCount(1);
  await expect(rows().first()).toContainText("Fixture Placement 055");
  responsePromise = waitForCollection("placements", (params) => params.get("query") === "Fixture Placement 055" && params.get("status") === "active");
  await page.locator(".filter-tabs").getByRole("button", { name: "Active", exact: true }).click();
  await responsePromise;
  await expectExport("placements", { query: "Fixture Placement 055", status: "active", active: "all" });
  responsePromise = waitForCollection("placements", (params) => params.get("query") === "" && params.get("status") === "active");
  await placementSearch.fill("");
  await responsePromise;
  responsePromise = waitForCollection("placements", (params) => params.get("query") === "" && params.get("status") === "all" && !params.has("cursor"));
  await page.locator(".filter-tabs").getByRole("button", { name: "All", exact: true }).click();
  await responsePromise;
  await expect(rows()).toHaveCount(50);
  responsePromise = waitForCollection("placements", (params) => params.has("cursor"));
  await page.getByRole("button", { name: "Load more placements", exact: true }).click();
  await responsePromise;
  await expect(rows()).toHaveCount(55);

  await page.getByRole("button", { name: "Students", exact: true }).click();
  await expect(rows()).toHaveCount(50);
  const studentSearch = page.getByRole("searchbox", { name: "Search students", exact: true });
  responsePromise = waitForCollection("students", (params) => params.get("query") === "Fixture Student 055" && params.get("active") === "all");
  await studentSearch.fill("Fixture Student 055");
  await responsePromise;
  await expect(studentSearch).toBeFocused();
  await expect(rows()).toHaveCount(1);
  const studentStatus = page.getByRole("combobox", { name: "Students status filter", exact: true });
  responsePromise = waitForCollection("students", (params) => params.get("query") === "Fixture Student 055" && params.get("active") === "false");
  await studentStatus.selectOption("false");
  await responsePromise;
  await expectExport("students", { query: "Fixture Student 055", active: "false", status: "all" });
  responsePromise = waitForCollection("students", (params) => params.get("query") === "" && params.get("active") === "false");
  await studentSearch.fill("");
  await responsePromise;
  responsePromise = waitForCollection("students", (params) => params.get("query") === "" && params.get("active") === "all" && !params.has("cursor"));
  await studentStatus.selectOption("all");
  await responsePromise;
  await expect(rows()).toHaveCount(50);
  responsePromise = waitForCollection("students", (params) => params.has("cursor"));
  await page.getByRole("button", { name: "Load more students", exact: true }).click();
  await responsePromise;
  await expect(rows()).toHaveCount(55);

  await page.getByRole("button", { name: "Hosts", exact: true }).click();
  await expect(rows()).toHaveCount(50);
  const hostSearch = page.getByRole("searchbox", { name: "Search hosts", exact: true });
  const slowRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/hosts" && url.searchParams.get("query") === "slow host";
  });
  await hostSearch.fill("slow host");
  await slowRequest;
  responsePromise = waitForCollection("hosts", (params) => params.get("query") === "Fixture Host 055" && params.get("active") === "all");
  await hostSearch.fill("Fixture Host 055");
  await responsePromise;
  await slowHostSettled;
  await expect(hostSearch).toBeFocused();
  await expect(hostSearch).toHaveValue("Fixture Host 055");
  await expect(rows()).toHaveCount(1);
  await expect(rows().first()).toContainText("Fixture Host 055");
  const hostStatus = page.getByRole("combobox", { name: "Hosts status filter", exact: true });
  responsePromise = waitForCollection("hosts", (params) => params.get("query") === "Fixture Host 055" && params.get("active") === "false");
  await hostStatus.selectOption("false");
  await responsePromise;
  await expectExport("hosts", { query: "Fixture Host 055", active: "false", status: "all" });
  responsePromise = waitForCollection("hosts", (params) => params.get("query") === "" && params.get("active") === "false");
  await hostSearch.fill("");
  await responsePromise;
  responsePromise = waitForCollection("hosts", (params) => params.get("query") === "" && params.get("active") === "all" && !params.has("cursor"));
  await hostStatus.selectOption("all");
  await responsePromise;
  await expect(rows()).toHaveCount(50);
  responsePromise = waitForCollection("hosts", (params) => params.has("cursor"));
  await page.getByRole("button", { name: "Load more hosts", exact: true }).click();
  await responsePromise;
  await expect(rows()).toHaveCount(55);

  await page.getByRole("button", { name: "Placements", exact: true }).click();
  await page.getByRole("button", { name: "New placement", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const lookupResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/lookups/hosts" && url.searchParams.get("query") === "Fixture Host 054";
  });
  await dialog.getByRole("searchbox", { name: "Host", exact: true }).fill("Fixture Host 054");
  await lookupResponse;
  const hostResults = dialog.getByRole("combobox", { name: "Search host results", exact: true });
  await expect(hostResults.getByRole("option", { name: /Fixture Host 054/ })).toHaveCount(1);
  await hostResults.selectOption("fixture-host-054");
  await expect(hostResults).toHaveValue("fixture-host-054");
  expect(lookupRequests.some((request) => request.query === "fixture host 054" && request.limit === 20)).toBeTruthy();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  expect(requests.filter((request) => ["placements", "students", "hosts"].includes(request.resource) && request.cursor).every((request) => request.limit === 50)).toBeTruthy();
});

test("exposes retention holds only to administrators and previews an exact retention batch", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Students", exact: true }).click();
  await page.getByRole("button", { name: "New student", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("First name").fill("Retention");
  await dialog.getByLabel("Last name").fill("Candidate");
  await dialog.getByLabel("External reference").fill("RETENTION-E2E");
  await dialog.getByRole("button", { name: "Create student", exact: true }).click();
  await expect(page.getByText("Student created.", { exact: true })).toBeVisible();

  const studentSearch = page.getByRole("searchbox", { name: "Search students", exact: true });
  const searchResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/students" && url.searchParams.get("query") === "Retention Candidate";
  });
  await studentSearch.fill("Retention Candidate");
  await searchResponse;
  const studentRow = page.locator(".data-table tbody tr").filter({ hasText: "Retention Candidate" });
  await expect(studentRow).toHaveCount(1);
  await studentRow.getByRole("button", { name: "Edit", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Legal/retention hold — exclude from automated retention")).toBeVisible();
  await dialog.getByLabel("Legal/retention hold — exclude from automated retention").check();
  await dialog.getByLabel("Active record").uncheck();
  await dialog.getByRole("button", { name: "Save student", exact: true }).click();
  await expect(page.getByText("Student updated.", { exact: true })).toBeVisible();
  await expect(page.locator(".data-table tbody tr").filter({ hasText: "Retention Candidate" })).toContainText("Retention hold");

  const editButton = page.locator(".data-table tbody tr").filter({ hasText: "Retention Candidate" }).getByRole("button", { name: "Edit", exact: true });
  await editButton.click();
  dialog = page.getByRole("dialog");
  await expect.poll(() => page.locator("#app").evaluate((node) => node.inert)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.locator("#app").evaluate((node) => node.inert)).toBe(false);
  await expect(editButton).toBeFocused();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const retentionOpener = page.getByRole("button", { name: "Review retention", exact: true });
  await retentionOpener.click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Erase records before").fill("2030-01-01");
  const previewResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/maintenance/retention") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Preview eligible batch", exact: true }).click();
  const previewResponse = await previewResponsePromise;
  expect(previewResponse.ok()).toBeTruthy();
  const preview = await previewResponse.json();
  await expect(dialog.getByText(new RegExp(`${preview.candidates} candidates in this batch\\.`))).toBeVisible();
  expect(preview.held).toBeGreaterThanOrEqual(1);
  if (preview.candidates > 0) {
    await dialog.getByLabel("Confirmation phrase").fill("ERASE EXPIRED RECORDS");
    const executeResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/maintenance/retention") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Execute approved batch", exact: true }).click();
    const executeResponse = await executeResponsePromise;
    expect(executeResponse.ok()).toBeTruthy();
    await expect(page.getByText("Retention batch completed.", { exact: true })).toBeVisible();
  } else {
    await expect(dialog.getByRole("button", { name: "Execute approved batch", exact: true })).toBeDisabled();
  }
});


test("paginates, filters and exports a bounded audit trail", async ({ page }) => {
  await signIn(page);
  const generated = await page.evaluate(async (email) => {
    const session = await fetch("/api/session", { headers: { Accept: "application/json" } }).then((response) => response.json());
    const users = await fetch("/api/users", { headers: { Accept: "application/json" } }).then((response) => response.json());
    const administrator = users.items.find((user) => user.email === email);
    let revision = administrator.revision;
    for (let index = 0; index < 56; index += 1) {
      const response = await fetch(`/api/users/${administrator.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({
          revision,
          displayName: index % 2 === 0 ? "VECTOR E2E Administrator Audit" : "VECTOR E2E Administrator",
        }),
      });
      if (!response.ok) return { ok: false, status: response.status };
      revision = (await response.json()).revision;
    }
    return { ok: true };
  }, E2E_EMAIL);
  expect(generated).toEqual({ ok: true });

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await expect(page.locator(".audit-row")).toHaveCount(50);
  await page.getByRole("button", { name: "Load more events", exact: true }).click();
  await expect.poll(() => page.locator(".audit-row").count()).toBeGreaterThan(50);

  await page.getByLabel("Action contains").fill("user.updated");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page.locator(".audit-row").first()).toContainText("User.Updated");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export filtered CSV", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/audit.*\.csv$/i);
  const csv = await readFile(await download.path(), "utf8");
  expect(csv).toContain("user.updated");
});

test("keeps every authenticated role accessible, keyboard-safe and responsive", async ({
  browserName,
  page,
}) => {
  // This deliberately runs repeated axe, overflow and keyboard audits across
  // four authenticated roles; WebKit needs more than the generic slow-test budget.
  test.setTimeout(120_000);
  const desktop = { height: 900, width: 1440 };
  const compact = { height: 844, width: 390 };
  const narrow = { height: 568, width: 320 };
  const tablet = { height: 1024, width: 768 };

  await signIn(page);
  expect(await page.evaluate(() => ({
    dialog: typeof HTMLDialogElement === "function"
      && typeof HTMLDialogElement.prototype.showModal === "function",
    download: "download" in HTMLAnchorElement.prototype,
    fetch: typeof globalThis.fetch === "function",
    inert: "inert" in HTMLElement.prototype,
  }))).toEqual({
    dialog: true,
    download: true,
    fetch: true,
    inert: true,
  });
  await ensureUserViaUi(page, {
    displayName: "E2E Coordinator",
    email: COORDINATOR_EMAIL,
    role: "coordinator",
    temporaryPassword: COORDINATOR_TEMP_PASSWORD,
  });
  await ensureUserViaUi(page, {
    displayName: "E2E Tutor",
    email: TUTOR_EMAIL,
    role: "tutor",
    temporaryPassword: TUTOR_TEMP_PASSWORD,
  });
  await ensureUserViaUi(page, {
    displayName: "E2E Viewer",
    email: VIEWER_EMAIL,
    role: "viewer",
    temporaryPassword: VIEWER_TEMP_PASSWORD,
  });
  await resetUserPasswordViaUi(page, {
    email: COORDINATOR_EMAIL,
    temporaryPassword: COORDINATOR_TEMP_PASSWORD,
  });
  await resetUserPasswordViaUi(page, {
    email: TUTOR_EMAIL,
    temporaryPassword: TUTOR_TEMP_PASSWORD,
  });
  await resetUserPasswordViaUi(page, {
    email: VIEWER_EMAIL,
    temporaryPassword: VIEWER_TEMP_PASSWORD,
  });

  await auditWorkspaceView(page, {
    heading: "Know what needs attention next.",
    label: "administrator overview at 1440px",
    navigation: "Overview",
    viewport: desktop,
  });
  await auditWorkspaceView(page, {
    heading: "Every placement, in context.",
    label: "administrator placements at 768px",
    navigation: "Placements",
    viewport: tablet,
  });
  await auditWorkspaceView(page, {
    heading: "Make the workspace your own.",
    label: "administrator settings at 390px",
    navigation: "Settings",
    viewport: compact,
  });

  const workspaceBrand = page.getByRole("link", { name: "Workspace overview", exact: true });
  await expect(workspaceBrand).toHaveAttribute("href", "./");
  await workspaceBrand.click();
  await expect(page.locator(".view-header h1")).toHaveText("Know what needs attention next.");
  await expectCurrentWorkspaceNavigationVisible(page, "brand-linked overview at 390px");

  await page.getByRole("button", { name: "Attention", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search attention items", exact: true }).fill("Maya");
  const mayaAttention = page.getByRole("row").filter({
    has: page.getByRole("button", { name: "Open placement", exact: true }),
    hasText: "Maya Keller",
  }).first();
  await expect(mayaAttention).toBeVisible();
  await mayaAttention.getByRole("button", { name: "Open placement", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Maya Keller", exact: true })).toBeVisible();
  await expectCurrentWorkspaceNavigationVisible(page, "placement opened from Attention at 390px");

  await page.setViewportSize(narrow);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  const keyboardSettings = page.getByRole("button", { name: "Settings", exact: true });
  await keyboardSettings.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".view-header h1")).toHaveText("Make the workspace your own.");
  await expect(page.locator(".view-header h1")).toBeFocused();
  await expectCurrentWorkspaceNavigationVisible(page, "keyboard-selected settings at 320px");
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator(".view-header h1")).toHaveText("Know what needs attention next.");
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to workspace", exact: true });
  if (
    browserName === "webkit"
    && !await skipLink.evaluate((node) => node === document.activeElement)
  ) {
    // WebKit inherits Safari's platform full-keyboard-access preference.
    await skipLink.focus();
  }
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await page.keyboard.press("Tab");
  const changePassword = page.getByRole("button", { name: "Change password", exact: true });
  await expect(changePassword).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Change password", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#app")).toHaveJSProperty("inert", true);
  await expect(dialog.getByLabel("Current password")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  const closeDialog = dialog.getByRole("button", { name: "Close dialog", exact: true });
  await expect(closeDialog).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Change password", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeDialog).toBeFocused();
  await expectNoWorkspaceOverflow(page, "change-password dialog at 320px");
  await expectAxeClean(page, "change-password dialog at 320px");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#app")).toHaveJSProperty("inert", false);
  await expect(changePassword).toBeFocused();

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signInAs(page, {
    email: COORDINATOR_EMAIL,
    permanentPassword: COORDINATOR_PASSWORD,
    temporaryPassword: COORDINATOR_TEMP_PASSWORD,
  });
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Coverage", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Audit", exact: true })).toBeVisible();
  await auditWorkspaceView(page, {
    heading: "Every student, accounted for.",
    label: "coordinator coverage at 390px",
    navigation: "Coverage",
    viewport: compact,
  });
  await auditWorkspaceView(page, {
    heading: "Rules that stay with the placement.",
    label: "coordinator programmes at 1440px",
    navigation: "Programmes",
    viewport: desktop,
  });
  await auditWorkspaceView(page, {
    heading: "Changes leave a trace.",
    label: "coordinator audit at 390px",
    navigation: "Audit",
    viewport: compact,
  });

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signInAs(page, {
    email: TUTOR_EMAIL,
    permanentPassword: TUTOR_ACCESSIBILITY_PASSWORD,
    temporaryPassword: TUTOR_TEMP_PASSWORD,
  });
  await expect(page.getByRole("button", { name: "Coverage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Audit", exact: true })).toHaveCount(0);
  await auditWorkspaceView(page, {
    heading: "Every placement, in context.",
    label: "tutor placements at 320px",
    navigation: "Placements",
    viewport: narrow,
  });
  await auditWorkspaceView(page, {
    heading: "Students",
    label: "tutor students at 390px",
    navigation: "Students",
    viewport: compact,
  });

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signInAs(page, {
    email: VIEWER_EMAIL,
    permanentPassword: VIEWER_ACCESSIBILITY_PASSWORD,
    temporaryPassword: VIEWER_TEMP_PASSWORD,
  });
  await expect(page.getByRole("button", { name: "Coverage", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Audit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await auditWorkspaceView(page, {
    heading: "Know what needs attention next.",
    label: "viewer overview at 1440px",
    navigation: "Overview",
    viewport: desktop,
  });
  await auditWorkspaceView(page, {
    heading: "Hosts",
    label: "viewer hosts at 390px",
    navigation: "Hosts",
    viewport: compact,
  });
});
