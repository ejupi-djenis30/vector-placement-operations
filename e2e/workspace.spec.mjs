import { expect, test } from "@playwright/test";

const LOCAL_ORIGIN = "http://127.0.0.1:4173";
const STORAGE_KEY = "vector-placement-demo";
const runtimeErrors = new WeakMap();

const placementRows = (page) => page.locator("[data-placement-list] .placement-row");
const placementFor = (page, student) => placementRows(page).filter({ hasText: student });

test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === LOCAL_ORIGIN || ["blob:", "data:"].includes(url.protocol)) {
      return route.continue();
    }
    return route.abort("blockedbyclient");
  });
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page) ?? [], "The page emitted runtime errors").toEqual([]);
});

async function openWorkspace(page) {
  await page.goto("./");
  await expect(page.locator('[data-metric="placements"]')).toHaveText("6");
  await expect(placementRows(page)).toHaveCount(6);
}

test("filters the cohort and reset restores the complete fixture state", async ({ page }) => {
  await openWorkspace(page);

  const mayaStatus = placementFor(page, "Maya Keller").getByRole("button");
  await expect(mayaStatus).toHaveText("Planned");
  await mayaStatus.click();
  await expect(mayaStatus).toHaveText("In progress");
  await expect(page.locator('[data-metric="active"]')).toHaveText("3");
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).not.toBeNull();

  const search = page.locator("[data-search]");
  await search.fill("Cobalt Systems");
  await expect(placementRows(page)).toHaveCount(1);
  await expect(placementRows(page).first()).toContainText("Sofia Marin");

  await search.clear();
  const reviewFilter = page.getByRole("button", { name: "Needs review", exact: true });
  await reviewFilter.click();
  await expect(reviewFilter).toHaveAttribute("aria-pressed", "true");
  await expect(placementRows(page)).toHaveCount(2);
  await expect(placementRows(page)).toContainText(["Sofia Marin", "Jonas Weber"]);

  await page.locator("[data-reset]").click();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("button", { name: "All", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(placementRows(page)).toHaveCount(6);
  await expect(placementFor(page, "Maya Keller").getByRole("button")).toHaveText("Planned");
  await expect(page.locator('[data-metric="active"]')).toHaveText("2");
  await expect(page.locator('[data-metric="review"]')).toHaveText("2");
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
});

test("persists a milestone change across a full reload", async ({ page }) => {
  await openWorkspace(page);

  const mayaStatus = placementFor(page, "Maya Keller").getByRole("button");
  await mayaStatus.click();
  await expect(mayaStatus).toHaveText("In progress");

  const persisted = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
  expect(persisted.find((record) => record.id === "PL-104").status).toBe("active");

  await page.reload();
  await expect(page.locator('[data-metric="placements"]')).toHaveText("6");
  await expect(page.locator('[data-metric="active"]')).toHaveText("3");
  await expect(placementFor(page, "Maya Keller").getByRole("button")).toHaveText("In progress");
});

for (const scenario of [
  { name: "truncated JSON", value: '{"id":' },
  { name: "invalid placement schema", value: '[{"id":"broken"}]' },
]) {
  test(`recovers from ${scenario.name} in local storage`, async ({ page }) => {
    await page.addInitScript(
      ({ key, value }) => localStorage.setItem(key, value),
      { key: STORAGE_KEY, value: scenario.value },
    );

    await openWorkspace(page);
    await expect(placementFor(page, "Maya Keller").getByRole("button")).toHaveText("Planned");
    await expect(page.locator('[data-metric="completion"]')).toHaveText("67");

    await page.reload();
    await expect(placementRows(page)).toHaveCount(6);
  });
}

test.describe("mobile viewport", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("keeps the interactive workspace inside the viewport", async ({ page }) => {
    await openWorkspace(page);
    await page.locator("#workspace").scrollIntoViewIfNeeded();

    const reviewFilter = page.getByRole("button", { name: "Needs review", exact: true });
    await reviewFilter.click();
    await expect(placementRows(page)).toHaveCount(2);

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
    await expect(page.locator(".console")).toBeVisible();
  });
});

test("keeps the hero board stable and symmetric across responsive boundaries", async ({ page }) => {
  const boardWidths = [];

  for (const width of [701, 700]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("./");
    const board = await page.locator(".hero-board").boundingBox();
    expect(board).not.toBeNull();
    boardWidths.push(board.width);
  }

  expect(Math.abs(boardWidths[0] - boardWidths[1])).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("./");

  const geometry = await page.evaluate(() => {
    const rectangle = (selector) => {
      const bounds = document.querySelector(selector).getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
      };
    };
    const steps = [...document.querySelectorAll(".flow-step")].map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.width,
      };
    });

    return {
      board: rectangle(".hero-board"),
      frame: rectangle(".board-frame"),
      flow: rectangle(".placement-flow"),
      progress: rectangle(".progress-panel"),
      steps,
    };
  });

  const frameLeftInset = geometry.frame.left - geometry.board.left;
  const frameRightInset = geometry.board.right - geometry.frame.right;
  expect(Math.abs(frameLeftInset - frameRightInset)).toBeLessThanOrEqual(1);

  const stepWidths = geometry.steps.map((step) => step.width);
  expect(Math.max(...stepWidths) - Math.min(...stepWidths)).toBeLessThanOrEqual(1);

  const leftGap = geometry.steps[1].left - geometry.steps[0].right;
  const rightGap = geometry.steps[2].left - geometry.steps[1].right;
  expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);

  const finalStepBottom = Math.max(...geometry.steps.map((step) => step.bottom));
  expect(finalStepBottom).toBeLessThanOrEqual(geometry.flow.bottom + 1);
  expect(geometry.progress.top - finalStepBottom).toBeGreaterThanOrEqual(7);
});
