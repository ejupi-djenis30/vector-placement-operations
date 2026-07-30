import { readFile, readdir, stat } from "node:fs/promises";
import {
  assertCssBackgroundLayers,
  assertCssSelectorDeclaration,
  assertContrastRatio,
  assertExternalScriptsOnly,
  assertRobotsTxt,
  assertSecurityTxt,
  assertSitemapXml,
  blendHexColorLayers,
  blendHexColors,
  combinedOpacity,
  cssSelectorDeclaration,
  parseCssRgbaLayers,
} from "./site-validation.mjs";

const PROJECT_PATH = "/vector-placement-operations/";
const PAGE_URL = "https://ejupi-djenis30.github.io/vector-placement-operations/";
const SOCIAL_IMAGE_URL = `${PAGE_URL}assets/social-preview.png`;
const SITEMAP_URL = `${PAGE_URL}sitemap.xml`;
const SECURITY_URL = `${PAGE_URL}.well-known/security.txt`;
const SECURITY_CONTACT_URL =
  "https://github.com/ejupi-djenis30/vector-placement-operations/security/advisories/new";
const SECURITY_POLICY_URL =
  "https://github.com/ejupi-djenis30/vector-placement-operations/security/policy";
const siteRoot = new URL("../site/", import.meta.url);
const repositoryRoot = new URL("../", siteRoot);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cssHexVariable(styles, name) {
  const value = cssSelectorDeclaration(styles, ":root", name);
  assert(
    /^#[0-9a-f]{6}$/i.test(value),
    `site/styles.css must define ${name} as a six-digit hexadecimal colour.`,
  );
  return value;
}

function assertColorLayer(
  layer,
  { color, label, opacity },
) {
  assert(
    layer.color.toLowerCase() === color.toLowerCase()
      && layer.opacity === opacity,
    `${label} must use ${color} at ${opacity} opacity.`,
  );
}

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && [".git", "node_modules", "release", "test-results"].includes(entry.name)) {
      continue;
    }
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await listFiles(
        new URL(`${entry.name}/`, directory),
        `${relativePath}/`,
      ));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function assertLocalReferences(html, pageUrl) {
  for (const [, attribute, reference] of html.matchAll(/\b(src|href)="([^"]+)"/g)) {
    if (
      reference.startsWith("#")
      || reference.startsWith("https://")
      || reference.startsWith("mailto:")
    ) {
      continue;
    }
    assert(!reference.startsWith("/"), `${attribute} must remain relative: ${reference}`);
    const target = new URL(reference.split(/[?#]/, 1)[0], pageUrl);
    assert(target.href.startsWith(siteRoot.href), `Local reference escapes site/: ${reference}`);
    const metadata = await stat(target);
    if (metadata.isDirectory()) {
      const index = await stat(new URL("index.html", target));
      assert(index.isFile(), `Local directory has no index.html: ${reference}`);
    } else {
      assert(metadata.isFile(), `Local reference is not a file: ${reference}`);
    }
  }
}

const [
  marketingHtml,
  workspaceHtml,
  styles,
  marketingApp,
  workspaceApp,
  robots,
  sitemap,
  security,
  readme,
  packageText,
  releasePolicyText,
  socialPreview,
  socialPreviewPng,
  dockerfile,
  compose,
  routes,
  schemas,
  migration,
  cursorSource,
  privacyAndRetention,
  importAndExport,
  backupAndRestore,
  releasing,
  selfHosting,
] = await Promise.all([
  readFile(new URL("index.html", siteRoot), "utf8"),
  readFile(new URL("app/index.html", siteRoot), "utf8"),
  readFile(new URL("styles.css", siteRoot), "utf8"),
  readFile(new URL("app.mjs", siteRoot), "utf8"),
  readFile(new URL("app/workspace.mjs", siteRoot), "utf8"),
  readFile(new URL("robots.txt", siteRoot), "utf8"),
  readFile(new URL("sitemap.xml", siteRoot), "utf8"),
  readFile(new URL(".well-known/security.txt", siteRoot), "utf8"),
  readFile(new URL("README.md", repositoryRoot), "utf8"),
  readFile(new URL("package.json", repositoryRoot), "utf8"),
  readFile(new URL("release-policy.json", repositoryRoot), "utf8"),
  readFile(new URL("assets/social-preview.svg", siteRoot), "utf8"),
  readFile(new URL("assets/social-preview.png", siteRoot)),
  readFile(new URL("Dockerfile", repositoryRoot), "utf8"),
  readFile(new URL("compose.yaml", repositoryRoot), "utf8"),
  readFile(new URL("server/routes.mjs", repositoryRoot), "utf8"),
  readFile(new URL("server/schemas.mjs", repositoryRoot), "utf8"),
  readFile(new URL("migrations/001_initial.sql", repositoryRoot), "utf8"),
  readFile(new URL("server/cursor.mjs", repositoryRoot), "utf8"),
  readFile(new URL("docs/privacy-and-retention.md", repositoryRoot), "utf8"),
  readFile(new URL("docs/import-export.md", repositoryRoot), "utf8"),
  readFile(new URL("docs/backup-restore.md", repositoryRoot), "utf8"),
  readFile(new URL("docs/releasing.md", repositoryRoot), "utf8"),
  readFile(new URL("docs/self-hosting.md", repositoryRoot), "utf8"),
]);
const packageJson = JSON.parse(packageText);
const releasePolicy = JSON.parse(releasePolicyText);

for (const file of [
  "index.html",
  "styles.css",
  "app.mjs",
  "app/index.html",
  "app/workspace.mjs",
  "api/public/branding.css",
  "assets/vector-mark.svg",
  "assets/vector-lockup.svg",
  "assets/social-preview.svg",
  "assets/social-preview.png",
  "robots.txt",
  "sitemap.xml",
  ".well-known/security.txt",
]) {
  const metadata = await stat(new URL(file, siteRoot));
  assert(metadata.isFile(), `Required publication file is not regular: ${file}`);
}

for (const token of [
  'lang="en"',
  "<main",
  'href="#content"',
  `rel="canonical" href="${PAGE_URL}"`,
  `property="og:url" content="${PAGE_URL}"`,
  `property="og:image" content="${SOCIAL_IMAGE_URL}"`,
  'name="twitter:card" content="summary_large_image"',
  'name="twitter:image:alt" content="VECTOR placement workflow with three completed readiness checks."',
  'data-workspace-link',
  'data-workspace-label',
  'href="app/"',
  'href="#self-host">Start the installation',
  'releases/tag/v3.3.0',
  'blob/main/docs/self-hosting.md',
  'Plan cohort coverage',
  'docker compose run --rm --no-deps vector',
  'remove bootstrap secret · docker compose up -d',
]) {
  assert(marketingHtml.includes(token), `site/index.html is missing ${token}`);
}
for (const token of [
  'lang="en"',
  'name="robots" content="noindex, nofollow"',
  'href="#workspace-main"',
  'id="app"',
  `src="workspace.mjs?v=${packageJson.version}"`,
]) {
  assert(workspaceHtml.includes(token), `site/app/index.html is missing ${token}`);
}
await assertLocalReferences(marketingHtml, new URL("index.html", siteRoot));
await assertLocalReferences(workspaceHtml, new URL("app/index.html", siteRoot));
assertExternalScriptsOnly(marketingHtml, "site/index.html");
assertExternalScriptsOnly(workspaceHtml, "site/app/index.html");

assert(
  /<svg\b[^>]*\bwidth="1200"[^>]*\bheight="630"[^>]*\bviewBox="0 0 1200 630"/i
    .test(socialPreview),
  "The social preview SVG must be exactly 1200 × 630.",
);
assert(
  /<title\b/i.test(socialPreview) && /<desc\b/i.test(socialPreview),
  "The social preview SVG must include a title and description.",
);
assert(
  socialPreviewPng.subarray(0, 8).equals(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  )
    && socialPreviewPng.readUInt32BE(16) === 1200
    && socialPreviewPng.readUInt32BE(20) === 630,
  "The social preview PNG must be exactly 1200 × 630.",
);
assertRobotsTxt(robots, { basePath: PROJECT_PATH, sitemapUrl: SITEMAP_URL });
assertSitemapXml(sitemap, { pageUrl: PAGE_URL });
assertSecurityTxt(security, {
  canonicalUrl: SECURITY_URL,
  contactUrl: SECURITY_CONTACT_URL,
  policyUrl: SECURITY_POLICY_URL,
});

for (const token of [
  "::selection",
  ":focus-visible",
  ".skip-link",
  ".coverage-table",
  "@media (max-width:",
  "@media (prefers-reduced-motion: reduce)",
]) {
  assert(styles.includes(token), `site/styles.css is missing ${token}`);
}
const creamColor = cssHexVariable(styles, "--cream");
const inkColor = cssHexVariable(styles, "--ink");
const mutedColor = cssHexVariable(styles, "--muted");
const coralBrightColor = cssHexVariable(styles, "--coral-bright");
const verticalGridLayer =
  /^linear-gradient\(\s*rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0?\.)?\d+\s*\)\s+1px\s*,\s*transparent\s+1px\s*\)$/i;
const horizontalGridLayer =
  /^linear-gradient\(\s*90deg\s*,\s*rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0?\.)?\d+\s*\)\s+1px\s*,\s*transparent\s+1px\s*\)$/i;
const translucentColorLayer =
  /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0?\.)?\d+\s*\)$/i;
for (const selector of [
  ".lead",
  ".workspace-entry",
  ".availability",
  ".workflow-grid p",
  ".control-list dd",
  ".self-host-copy",
  ".site-footer p",
]) {
  assertCssSelectorDeclaration(styles, {
    expected: "var(--muted)",
    property: "color",
    selector,
  });
}
assertCssSelectorDeclaration(styles, {
  expected: "var(--coral-bright)",
  property: "color",
  selector: ".signal-meter b",
});
assertCssSelectorDeclaration(styles, {
  expected: "var(--coral-bright)",
  property: "background",
  selector: ".signal-topline i",
});
const signalIndicatorGlow = parseCssRgbaLayers(
  cssSelectorDeclaration(styles, ".signal-topline i", "box-shadow"),
);
assert(
  signalIndicatorGlow.length === 1,
  "The signal indicator must use exactly one translucent glow.",
);
assertColorLayer(signalIndicatorGlow[0], {
  color: coralBrightColor,
  label: "Signal indicator glow",
  opacity: 0.15,
});
assertCssSelectorDeclaration(styles, {
  expected: "var(--ink)",
  property: "background",
  selector: ".signal-board",
});

const bodyBackground = cssSelectorDeclaration(styles, "body", "background");
assertCssBackgroundLayers(bodyBackground, {
  expected: [verticalGridLayer, horizontalGridLayer, "var(--cream)"],
  label: "Public page body background",
});
const bodyGridLayers = parseCssRgbaLayers(bodyBackground);
assert(
  bodyBackground.endsWith("var(--cream)"),
  "The public page body grid must resolve over var(--cream).",
);
assert(bodyGridLayers.length === 2, "The public page body must use exactly two grid layers.");
for (const [index, layer] of bodyGridLayers.entries()) {
  assertColorLayer(layer, {
    color: inkColor,
    label: `Body grid layer ${index + 1}`,
    opacity: 0.04,
  });
}
const bodyGridIntersection = blendHexColorLayers(
  creamColor,
  [...bodyGridLayers].reverse(),
);
assertContrastRatio(mutedColor, bodyGridIntersection, {
  label: "Muted marketing copy",
  minimum: 4.5,
});

const signalGridBackground = cssSelectorDeclaration(
  styles,
  ".signal-grid",
  "background",
);
assertCssBackgroundLayers(signalGridBackground, {
  expected: [verticalGridLayer, horizontalGridLayer],
  label: "Signal-grid background",
});
const signalGridLayers = parseCssRgbaLayers(signalGridBackground);
assert(signalGridLayers.length === 2, "The signal board must use exactly two grid layers.");
for (const [index, layer] of signalGridLayers.entries()) {
  assertColorLayer(layer, {
    color: creamColor,
    label: `Signal grid layer ${index + 1}`,
    opacity: 0.055,
  });
}
const signalGridElementOpacity = Number(
  cssSelectorDeclaration(styles, ".signal-grid", "opacity"),
);
assert(
  signalGridElementOpacity === 0.9,
  "The signal-grid element opacity must remain 0.9.",
);
const signalGridOpacity =
  combinedOpacity(signalGridLayers.map(({ opacity }) => opacity))
  * signalGridElementOpacity;
const signalGridIntersection = blendHexColors(
  creamColor,
  inkColor,
  signalGridOpacity,
);
const signalMeterBackground = cssSelectorDeclaration(
  styles,
  ".signal-meter",
  "background",
);
assertCssBackgroundLayers(signalMeterBackground, {
  expected: [translucentColorLayer],
  label: "Signal-meter background",
});
const signalMeterLayers = parseCssRgbaLayers(signalMeterBackground);
assert(
  signalMeterLayers.length === 1,
  "The signal meter must use exactly one translucent surface layer.",
);
assertColorLayer(signalMeterLayers[0], {
  color: creamColor,
  label: "Signal-meter surface",
  opacity: 0.06,
});
const signalMeterIntersection = blendHexColorLayers(
  signalGridIntersection,
  signalMeterLayers,
);
assertContrastRatio(coralBrightColor, signalMeterIntersection, {
  label: "Signal-meter value",
  minimum: 4.5,
});
for (const [name, source] of [
  ["site/app.mjs", marketingApp],
  ["site/app/workspace.mjs", workspaceApp],
]) {
  assert(!/\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval)\b/.test(source), `${name} uses an unsafe DOM sink.`);
  assert(!/new\s+Function\b/.test(source), `${name} constructs executable source.`);
  assert(!/\.style\b/.test(source), `${name} creates CSP-blocked inline styles.`);
}
assert(workspaceApp.includes('credentials: "same-origin"'), "Workspace requests must be same-origin.");
assert(workspaceApp.includes('"X-CSRF-Token"'), "Workspace mutations must send a CSRF token.");
assert(workspaceApp.includes("loadCoverage"), "Workspace cohort coverage is missing.");
assert(workspaceApp.includes("canViewCoverage"), "Coverage scope guard is missing.");

const repositoryFiles = await listFiles(repositoryRoot);
for (const file of repositoryFiles) {
  assert(!/(?:^|\/)(?:PCTO\.sql|[^/]+\.docx)$/i.test(file), `Sensitive legacy artifact found: ${file}`);
  assert(!/\.(?:mp4|webm|mov|m4v|avi)$/i.test(file), `Retired video asset found: ${file}`);
  assert(
    !/(?:^|\/)\.env$/i.test(file)
      && !/\.(?:sqlite|sqlite3|db|backup)$/i.test(file)
      && !/(?:^|\/)backups?\//i.test(file),
    `Runtime data or secret-bearing configuration found: ${file}`,
  );
}

const textFiles = repositoryFiles.filter((file) =>
  /\.(?:css|html?|js|mjs|json|md|svg|txt|ya?ml|sql)$/i.test(file)
  && file !== "scripts/validate-site.mjs"
  && file !== "package-lock.json"
);
const repositoryText = (await Promise.all(
  textFiles.map((file) => readFile(
    new URL(file.replaceAll("\\", "/"), repositoryRoot),
    "utf8",
  )),
)).join("\n");
const privateKeyMarkers = [
  ["OPENSSH", "PRIVATE", "KEY"],
  ["RSA", "PRIVATE", "KEY"],
  ["EC", "PRIVATE", "KEY"],
  ["DSA", "PRIVATE", "KEY"],
  ["PGP", "PRIVATE", "KEY", "BLOCK"],
].map((words) => `-----BEGIN ${words.join(" ")}-----`);
for (const marker of privateKeyMarkers) {
  assert(!repositoryText.includes(marker), `Private-key material found: ${marker}`);
}
const repositoryEmails = [...repositoryText.matchAll(
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
)].map(([email]) => email.toLocaleLowerCase("en"));
const allowedReleaseEmail = releasePolicy.tagger.email.toLocaleLowerCase("en");
assert(
  repositoryEmails.every((email) =>
    email.endsWith("@example.test")
      || email.endsWith("@example.org")
      || email.endsWith("@example.com")
      || email === allowedReleaseEmail
  ),
  "A non-fixture personal or operational email address is present.",
);
assert(!/[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]/i.test(repositoryText), "An Italian tax identifier is present.");

assert(packageJson.name === "vector-placement-operations", "package name is not VECTOR.");
assert(packageJson.homepage === PAGE_URL, "package homepage does not match GitHub Pages.");
assert(packageJson.license === "MIT", "package license must be MIT.");
assert(packageJson.engines?.node === ">=22", "Node.js support must start at 22.");
for (const script of [
  "start",
  "test",
  "test:e2e",
  "db:migrate",
  "db:backup",
  "db:inspect-backup",
  "db:restore",
  "db:compact",
  "doctor",
  "check",
]) {
  assert(packageJson.scripts?.[script], `package.json is missing ${script}.`);
}
assert(/Released under the \[MIT License\]\(LICENSE\)\./i.test(readme), "README must link the MIT license.");

for (const token of [
  "FROM node:26.5.0-bookworm-slim@sha256:",
  "scripts/compact.mjs",
  "USER node",
  'CMD ["node", "server/index.mjs"]',
]) {
  assert(dockerfile.includes(token), `Dockerfile is missing ${token}`);
}
assert(
  (dockerfile.match(/FROM node:26\.5\.0-bookworm-slim@sha256:[0-9a-f]{64}/g) ?? []).length === 2,
  "Both Docker stages must pin the Node 26 runtime by digest.",
);
for (const token of [
  "read_only: true",
  "cap_drop:",
  "- ALL",
  "no-new-privileges:true",
  "pids_limit: 256",
  "stop_grace_period: 30s",
]) {
  assert(compose.includes(token), `compose.yaml is missing ${token}`);
}

assert(
  routes.includes('app.get("/api/import/:resource/template"'),
  "The API must expose stable CSV templates.",
);
assert(routes.includes('app.get("/api/coverage"'), "The coverage API route is missing.");
assert(schemas.includes("CoverageResponse"), "The coverage response contract is missing.");
assert(
  !routes.includes('app.delete("/api/students/:id"'),
  "Individual student erasure must not bypass governed retention.",
);
assert(schemas.includes("retentionHold: z.boolean()"), "Student retention hold is missing.");
assert(migration.includes("retention_hold INTEGER NOT NULL DEFAULT 0"), "Retention hold is missing from the schema.");
for (const token of [
  "createCipheriv",
  "createDecipheriv",
  '"aes-256-gcm"',
  "cipher.setAAD(header)",
  "randomBytes(NONCE_BYTES)",
]) {
  assert(cursorSource.includes(token), `Confidential cursor implementation is missing ${token}`);
}
assert(!cursorSource.includes("createHmac"), "Cursor positions must not remain readable under an HMAC.");
assert(routes.includes('request.get("If-Match")'), "Logo mutations must require an If-Match revision.");
assert(routes.includes('"precondition_required"'), "Logo precondition failures need a stable error code.");

for (const token of [
  "does not expose an individual student-delete endpoint",
  "`retentionHold`",
  "`updated_at`",
  "`ERASE EXPIRED RECORDS`",
  '"fingerprint"',
  "1,000",
  "`hasMore`",
  "`cleanupPending: true`",
  "db:compact -- --confirm-maintenance",
  "cohort coverage board",
  "inactivity session limits",
  "reverse-proxy access logs to omit the entire query string",
]) {
  assert(privacyAndRetention.includes(token), `Retention runbook is missing ${token}`);
}
for (const token of [
  "GET /api/import/students/template",
  "GET /api/import/hosts/template",
  "GET /api/import/placements/template",
  "externalRef,firstName,lastName,email,cohortName,cohortAcademicYear",
  "studentExternalRef,hostName,programmeCode,periodName,schoolTutorEmail",
  "not VECTOR's internal UUIDs",
  "10,000",
  "`422 export_row_limit`",
  "`query=<text>`",
  "`active=true`",
  "`status=planned|active|review|complete|cancelled`",
]) {
  assert(importAndExport.includes(token), `Import/export runbook is missing ${token}`);
}
for (const token of [
  "docker compose cp",
  ".manifest.json",
  ":/restore-source:ro",
  "icacls.exe",
  "mode `0700`",
  "mode `0600`",
  "vector.sqlite-journal",
  "vector-recovery-YYYYMMDD",
  "db:compact -- --confirm-maintenance",
]) {
  assert(backupAndRestore.includes(token), `Backup/restore runbook is missing ${token}`);
}
for (const token of [
  "scripts/release-cli.mjs accept",
  'candidate_root="$(mktemp -d)"',
  "outside the repository",
  "read-only root filesystem",
  "`SIGTERM`",
  "runner-temporary directories",
]) {
  assert(releasing.includes(token), `Release runbook is missing ${token}`);
}
for (const token of [
  "`VECTOR_BOOTSTRAP_TIME_ZONE`",
  "`--env-file-if-exists=.env`",
  "blocks every workspace route",
  "`If-Match`",
  "`428 precondition_required`",
  "omit the entire query string",
  "`request.path`",
  "`VECTOR_DEFAULT`",
  "`VECTOR_SESSION_IDLE_MINUTES`",
  "Server-enforced inactivity timeout",
  "Cohort coverage planning",
  "VECTOR 3.3 adds no database migration",
  "manually added documents",
  "up to 200 programmes",
  "up to 100 published versions",
]) {
  assert(selfHosting.includes(token), `Self-hosting runbook is missing ${token}`);
}

const workflowRoot = new URL(".github/workflows/", repositoryRoot);
const workflows = new Map();
for (const entry of await readdir(workflowRoot, { withFileTypes: true })) {
  if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
    workflows.set(entry.name, await readFile(new URL(entry.name, workflowRoot), "utf8"));
  }
}
for (const required of ["ci.yml", "pages.yml", "release.yml"]) {
  assert(workflows.has(required), `Missing workflow: ${required}`);
}
for (const [name, workflow] of workflows) {
  assert(!/pull_request_target\s*:/i.test(workflow), `${name} uses pull_request_target.`);
  assert(!/permissions:\s*write-all/i.test(workflow), `${name} grants write-all.`);
  for (const match of workflow.matchAll(/\buses:\s*([^\s#]+)/g)) {
    assert(/@[0-9a-f]{40}$/i.test(match[1]), `${name} does not pin ${match[1]}.`);
  }
}
assert(
  (workflows.get("release.yml").match(/contents: write/g) ?? []).length === 1,
  "Release publication must be the only contents-write grant.",
);
for (const token of [
  "actions/configure-pages@",
  "actions/upload-pages-artifact@",
  "actions/deploy-pages@",
  "path: site",
  "include-hidden-files: true",
  "name: github-pages",
]) {
  assert(workflows.get("pages.yml").includes(token), `pages.yml is missing ${token}`);
}
for (const token of [
  'NODE_VERSION: "22.23.1"',
  "scripts/release-cli.mjs accept",
  "docker build --check .",
  "npm run db:restore",
  "Independent reproducibility gate",
  "subject-checksums: release/SHA256SUMS",
]) {
  assert(workflows.get("release.yml").includes(token), `release.yml is missing ${token}`);
}

console.log("VECTOR publication and distribution validation passed.");
