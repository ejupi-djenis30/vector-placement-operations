import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const E2E_EMAIL = "vector-e2e-admin@example.test";
const E2E_BOOTSTRAP_PASSWORD = process.env.VECTOR_E2E_PASSWORD ?? "vector-e2e-password-2026";
const E2E_PASSWORD = "vector-e2e-permanent-password-2026";
const VIEWER_EMAIL = "viewer.e2e@example.test";
const VIEWER_TEMP_PASSWORD = "viewer-temporary-password-2026";
const VIEWER_RESET_PASSWORD = "viewer-reset-password-2026";
const VIEWER_PASSWORD = "viewer-permanent-password-2026";
const TUTOR_EMAIL = "tutor.e2e@example.test";
const TUTOR_TEMP_PASSWORD = "tutor-temporary-password-2026";
const TUTOR_PASSWORD = "tutor-permanent-password-2026";
const runtimeErrors = new WeakMap();
const expectedHttpFailures = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  expectedHttpFailures.set(page, new Set());
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const status = Number(message.text().match(/Failed to load resource:.*status of (\d+)/)?.[1]);
    if (status && expectedHttpFailures.get(page)?.has(status)) return;
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
  await expect(page.getByRole("heading", { name: "Keep the next action visible." })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Keep the next action visible." })).toBeVisible();
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

async function openPlacement(page, studentName) {
  await page.getByRole("button", { name: "Placements", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Every placement, in context." })).toBeVisible();
  const row = page.locator(".data-table tbody tr").filter({ hasText: studentName });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: /hours logged/ })).toBeVisible();
}

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
  await expect(page.getByRole("heading", { name: "Keep the next action visible." })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator(".workspace-topbar")).toBeInViewport();
});

test("signs in to the self-hosted workspace and records a verifiable time entry", async ({ page }) => {
  await signIn(page);
  await expect(page.locator(".metric")).toHaveCount(4);
  await expect(page.getByText("Placement queue", { exact: true })).toBeVisible();

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
  await openPlacement(page, "Noah Rossi");
  await expect(page.getByRole("button", { name: /Add time entry|Add check-in|Add document|Update status|Reopen placement|Edit placement|Verify|Reject|Void|Archive|Supersede/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to the workspace." })).toBeVisible();
  await signInAs(page, { email: TUTOR_EMAIL, temporaryPassword: TUTOR_TEMP_PASSWORD, permanentPassword: TUTOR_PASSWORD });
  await expect(page.getByRole("button", { name: "Audit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await openPlacement(page, "Noah Rossi");
  await expect(page.getByRole("button", { name: "Add time entry", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add check-in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add document", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Update status|Reopen placement|Edit placement|Verify|Reject|Void|Archive|Supersede/ })).toHaveCount(0);
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
  await expect(page.getByRole("heading", { name: "Keep the next action visible." })).toBeVisible();
  await page.getByRole("button", { name: "Placements", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Every placement, in context." })).toBeVisible();
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
