import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import {
  assertCssBackgroundLayers,
  assertBalancedCssBlocks,
  assertCssSelectorDeclaration,
  assertContrastRatio,
  assertExternalScriptsOnly,
  assertRobotsTxt,
  assertRoleScopeClaims,
  assertSecurityTxt,
  assertSitemapXml,
  blendHexColorLayers,
  blendHexColors,
  combinedOpacity,
  cssSelectorDeclaration,
  normalizedElementText,
  parseCssRgbaLayers,
} from "./site-validation.mjs";
import { ROLE_DATA_SCOPES } from "../server/rbac.mjs";

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
    `site/styles/shared.css must define ${name} as a six-digit hexadecimal colour.`,
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
  sharedStyles,
  marketingStyles,
  workspaceStyles,
  apiClientApp,
  coreApp,
  workspaceDomainApp,
  workspaceProgrammesApp,
  workspaceUiApp,
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
  collectionMigration,
  activityCapacityMigration,
  sessionCapacityMigration,
  userCapacityMigration,
  activityLimits,
  userLimits,
  cursorSource,
  privacyAndRetention,
  importAndExport,
  backupAndRestore,
  releasing,
  selfHosting,
] = await Promise.all([
  readFile(new URL("index.html", siteRoot), "utf8"),
  readFile(new URL("app/index.html", siteRoot), "utf8"),
  readFile(new URL("styles/shared.css", siteRoot), "utf8"),
  readFile(new URL("styles/marketing.css", siteRoot), "utf8"),
  readFile(new URL("styles/workspace.css", siteRoot), "utf8"),
  readFile(new URL("app/api-client.mjs", siteRoot), "utf8"),
  readFile(new URL("app/core.mjs", siteRoot), "utf8"),
  readFile(new URL("app/workspace-domain.mjs", siteRoot), "utf8"),
  readFile(new URL("app/workspace-programmes.mjs", siteRoot), "utf8"),
  readFile(new URL("app/workspace-ui.mjs", siteRoot), "utf8"),
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
  readFile(new URL("migrations/003_collection_sort_indexes.sql", repositoryRoot), "utf8"),
  readFile(new URL("migrations/004_placement_activity_capacity.sql", repositoryRoot), "utf8"),
  readFile(new URL("migrations/005_active_session_capacity.sql", repositoryRoot), "utf8"),
  readFile(new URL("migrations/006_user_capacity.sql", repositoryRoot), "utf8"),
  readFile(new URL("server/placement-activity-limits.mjs", repositoryRoot), "utf8"),
  readFile(new URL("server/user-limits.mjs", repositoryRoot), "utf8"),
  readFile(new URL("server/cursor.mjs", repositoryRoot), "utf8"),
  readFile(new URL("docs/privacy-and-retention.md", repositoryRoot), "utf8"),
  readFile(new URL("docs/import-export.md", repositoryRoot), "utf8"),
  readFile(new URL("docs/backup-restore.md", repositoryRoot), "utf8"),
  readFile(new URL("docs/releasing.md", repositoryRoot), "utf8"),
  readFile(new URL("docs/self-hosting.md", repositoryRoot), "utf8"),
]);
const styles = [sharedStyles, marketingStyles, workspaceStyles].join("\n");
const packageJson = JSON.parse(packageText);
const releasePolicy = JSON.parse(releasePolicyText);

for (const file of [
  "index.html",
  "styles/marketing.css",
  "styles/shared.css",
  "styles/workspace.css",
  "app/api-client.mjs",
  "app/core.mjs",
  "app/index.html",
  "app/workspace-domain.mjs",
  "app/workspace-programmes.mjs",
  "app/workspace-ui.mjs",
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
  'href="#self-host" data-workspace-link',
  'Installation required',
  'You are viewing the public product page.',
  'role="img" aria-label="Illustration of the VECTOR placement flow"',
  'role="img" aria-label="VECTOR deployment boundary"',
  'role="group" aria-label="Self-hosting commands"',
  'href="#self-host">Start the installation',
  'releases/tag/v3.3.0',
  'blob/main/docs/self-hosting.md',
  'Plan cohort coverage',
  'id="product"',
  'id="trust"',
  'class="workspace-preview"',
  'class="capability-grid"',
  'class="role-grid"',
  'No managed VECTOR cloud required',
  'Infrastructure-operated recovery',
  'host-level commands outside application roles',
  'docker compose run --rm --no-deps vector',
  'remove bootstrap secret · docker compose up -d',
]) {
  assert(marketingHtml.includes(token), `site/index.html is missing ${token}`);
}

for (const [id, expected] of [
  ["hero-title", "Keep each placement accountable."],
  ["product-title", "See the programme. Act on the gap."],
  ["workflow-title", "One workflow. Each decision traceable."],
  ["controls-title", "Straightforward to operate. Explicit where it matters."],
  ["self-host-title", "A public product page. A private workspace."],
]) {
  assert(
    normalizedElementText(marketingHtml, id) === expected,
    `site/index.html #${id} must preserve a word boundary across its visual line break.`,
  );
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
assertRoleScopeClaims(marketingHtml, ROLE_DATA_SCOPES);
assertExternalScriptsOnly(marketingHtml, "site/index.html", {
  allowedInlineScriptTypes: ["application/ld+json"],
});
assertExternalScriptsOnly(workspaceHtml, "site/app/index.html");
const structuredDataMatches = [...marketingHtml.matchAll(
  /<script type="application\/ld\+json">([^<]+)<\/script>/g,
)];
assert(
  structuredDataMatches.length === 1,
  "The public presentation must contain exactly one SoftwareApplication JSON-LD block.",
);
let structuredData;
try {
  structuredData = JSON.parse(structuredDataMatches[0][1]);
} catch {
  throw new Error("The public SoftwareApplication JSON-LD must be valid JSON.");
}
const repositoryUrl = packageJson.repository.url
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");
const expectedStructuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "VECTOR — Placement Operations",
  description: "A free, MIT-licensed, self-hosted placement operations workspace for schools.",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Linux",
  softwareVersion: packageJson.version,
  url: PAGE_URL,
  downloadUrl: `${repositoryUrl}/releases/tag/v${packageJson.version}`,
  codeRepository: repositoryUrl,
  license: "https://opensource.org/license/mit/",
  isAccessibleForFree: true,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
};
assert(
  JSON.stringify(structuredData) === JSON.stringify(expectedStructuredData),
  "SoftwareApplication JSON-LD must match canonical package, release, repository and MIT license metadata.",
);
assert(packageJson.license === "MIT", "Structured-data license validation requires package MIT parity.");
const structuredDataHash = createHash("sha256")
  .update(structuredDataMatches[0][1], "utf8")
  .digest("base64");
const marketingCsp = marketingHtml.match(
  /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/,
)?.[1];
assert(
  marketingCsp === "default-src 'none'; base-uri 'none'; form-action 'none'; "
    + `script-src 'sha256-${structuredDataHash}'; style-src 'self'; img-src 'self'; `
    + "connect-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; "
    + "media-src 'none'; worker-src 'none'",
  "The public meta CSP must allow only its exact JSON-LD hash and same-origin styles/images.",
);
assert(
  marketingHtml.indexOf('http-equiv="Content-Security-Policy"')
    < marketingHtml.indexOf("<script"),
  "The public meta CSP must precede structured data.",
);
assert(
  workspaceHtml.includes(
    "default-src 'none'; base-uri 'none'; form-action 'self'; script-src 'self'; "
      + "style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; "
      + "object-src 'none'; frame-src 'none'; media-src 'none'; worker-src 'none'",
  ),
  "The Pages workspace must retain a self-only meta CSP beneath the authoritative Helmet policy.",
);
assert(
  marketingHtml.includes('href="api/public/branding.css"'),
  "The GitHub Pages presentation must retain its published branding fallback.",
);
assert(
  [...marketingHtml.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)]
    .map((match) => match[1])
    .join("\n") === [
      "styles/shared.css",
      "styles/marketing.css",
      "api/public/branding.css",
    ].join("\n"),
  "The public presentation must load only shared, marketing and runtime-branding CSS in cascade order.",
);
assert(
  workspaceHtml.includes('href="../api/public/branding.css"'),
  "The private workspace must retain runtime application branding.",
);
assert(
  [...workspaceHtml.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)]
    .map((match) => match[1])
    .join("\n") === [
      "../styles/shared.css",
      "../styles/workspace.css",
      "../api/public/branding.css",
    ].join("\n"),
  "The private workspace must load only shared, workspace and runtime-branding CSS in cascade order.",
);
assert(
  !/(?:\.workspace-page|\.workspace-shell|\.login-screen|\.data-table|\.modal-card)/.test(marketingStyles),
  "Marketing CSS must not contain authenticated workspace selectors.",
);
assert(
  !/(?:\.marketing-page|\.site-footer|\.signal-board|\.proof-strip|\.trust-section)/.test(workspaceStyles),
  "Workspace CSS must not contain public presentation selectors.",
);
assert(
  !/(?:\.marketing-page|\.workspace-page|\.site-footer|\.workspace-shell)/.test(sharedStyles),
  "Shared CSS must remain page-agnostic.",
);
const cssBytes = {
  marketing: Buffer.byteLength(marketingStyles),
  shared: Buffer.byteLength(sharedStyles),
  workspace: Buffer.byteLength(workspaceStyles),
};
for (const [name, source] of [
  ["marketing", marketingStyles],
  ["shared", sharedStyles],
  ["workspace", workspaceStyles],
]) {
  assertBalancedCssBlocks(source, `${name} CSS`);
  assert(!/@import\b/i.test(source), `${name} CSS must use the explicit stylesheet graph.`);
  assert(
    !/url\(\s*["']?(?:data:|https?:|\/\/)/i.test(source),
    `${name} CSS must not embed or fetch cross-origin resources.`,
  );
}
assert(cssBytes.shared <= 4_000, `Shared CSS exceeded its 4 KB source budget: ${cssBytes.shared} bytes.`);
assert(cssBytes.marketing <= 30_000, `Marketing CSS exceeded its 30 KB source budget: ${cssBytes.marketing} bytes.`);
assert(cssBytes.workspace <= 26_000, `Workspace CSS exceeded its 26 KB source budget: ${cssBytes.workspace} bytes.`);
assert(
  cssBytes.shared + cssBytes.marketing <= 34_000,
  "The public presentation CSS graph exceeded its 34 KB source budget.",
);
assert(
  cssBytes.shared + cssBytes.workspace <= 30_000,
  "The authenticated workspace CSS graph exceeded its 30 KB source budget.",
);

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
  assert(styles.includes(token), `The split site CSS graph is missing ${token}`);
}
assert(
  !/\.site-footer\s+p\s*\{[^}]*display\s*:\s*none/iu.test(marketingStyles),
  "Responsive styles must keep the footer licence metadata visible.",
);
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
  ["site/app/api-client.mjs", apiClientApp],
  ["site/app/core.mjs", coreApp],
  ["site/app/workspace-domain.mjs", workspaceDomainApp],
  ["site/app/workspace-programmes.mjs", workspaceProgrammesApp],
  ["site/app/workspace-ui.mjs", workspaceUiApp],
  ["site/app/workspace.mjs", workspaceApp],
]) {
  assert(!/\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval)\b/.test(source), `${name} uses an unsafe DOM sink.`);
  assert(!/new\s+Function\b/.test(source), `${name} constructs executable source.`);
  assert(!/\.style\b/.test(source), `${name} creates CSP-blocked inline styles.`);
}
assert(apiClientApp.includes('credentials: "same-origin"'), "Workspace requests must be same-origin.");
assert(apiClientApp.includes('"X-CSRF-Token"'), "Workspace mutations must send a CSRF token.");
assert(workspaceApp.includes("createApiClient"), "Workspace API client boundary is missing.");
assert(workspaceApp.includes("createProgrammeFeature"), "Programme feature boundary is missing.");
assert(workspaceApp.includes("createWorkspaceUi"), "Workspace UI boundary is missing.");
assert(workspaceDomainApp.includes("workspaceAccess"), "Workspace access policy boundary is missing.");
assert(workspaceApp.includes("loadCoverage"), "Workspace cohort coverage is missing.");
assert(workspaceApp.includes("canViewCoverage"), "Coverage scope guard is missing.");
for (const token of [
  "workspaceRecoveryScreen",
  "The workspace is temporarily unavailable.",
  'text: "Try again"',
  'app.setAttribute("aria-busy", "true")',
  'element("main", { class: "login-card" }',
]) {
  assert(workspaceApp.includes(token), `Workspace recovery contract is missing ${token}.`);
}

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
assert(
  packageJson.engines?.node === ">=22.23.1 <23 || >=24.18.0 <25",
  "Node.js support must stay inside the tested Node 22 and 24 LTS lines.",
);
for (const script of [
  "start",
  "test",
  "test:coverage",
  "test:e2e",
  "test:e2e:webkit",
  "audit:scale",
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
for (const script of [
  "test",
  "test:coverage",
  "test:e2e",
  "test:e2e:webkit",
  "audit:scale",
  "db:migrate",
  "db:backup",
  "db:inspect-backup",
  "db:restore",
  "db:compact",
  "admin:create",
  "doctor",
  "check:audit",
  "check:site",
  "check:release",
  "release:tag-preflight",
  "release:tag-verify",
  "release:build",
  "release:verify",
  "check",
]) {
  assert(
    packageJson.scripts?.[script]?.startsWith("node scripts/runtime-preflight.mjs && "),
    `${script} must reject unsupported Node before starting its workload.`,
  );
}
assert(/Released under the \[MIT License\]\(LICENSE\)\./i.test(readme), "README must link the MIT license.");

for (const token of [
  "FROM node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd",
  "npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
  "node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --release --force_build=1",
  "rm -rf prebuilds",
  "/usr/local/lib/node_modules/npm",
  "/usr/local/lib/node_modules/corepack",
  "/opt/yarn-v1.22.22",
  "/usr/local/bin/npm",
  "/usr/local/bin/npx",
  "/usr/local/bin/corepack",
  "/usr/local/bin/yarn",
  "/usr/local/bin/yarnpkg",
  "/usr/local/bin/pnpm",
  "/usr/local/bin/pnpx",
  "--chown=root:root /app/node_modules",
  "LICENSE /usr/share/licenses/vector/LICENSE",
  "chown -R root:root /app",
  "chmod -R go-w /app",
  "scripts/compact.mjs",
  "USER node",
  "ENTRYPOINT []",
  'CMD ["node", "server/index.mjs"]',
]) {
  assert(dockerfile.includes(token), `Dockerfile is missing ${token}`);
}
assert(
  (dockerfile.match(/FROM node:24\.18\.0-alpine3\.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd/g) ?? []).length === 2,
  "Both Docker stages must pin the same Node 24 LTS multi-architecture digest.",
);
for (const token of [
  "read_only: true",
  "cap_drop:",
  "- ALL",
  "no-new-privileges:true",
  "pids_limit: 256",
  "stop_grace_period: 70s",
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
assert(
  collectionMigration.includes("idx_students_school_name")
    && collectionMigration.includes("idx_hosts_school_name"),
  "Collection sort indexes are missing from the migration.",
);
assert(
  activityCapacityMigration.includes("time_entries_placement_capacity")
    && activityCapacityMigration.includes("check_ins_placement_capacity")
    && activityCapacityMigration.includes("documents_placement_capacity")
    && activityCapacityMigration.includes("idx_time_entries_placement_detail")
    && activityCapacityMigration.includes("idx_check_ins_placement_detail")
    && activityCapacityMigration.includes("idx_documents_placement_detail"),
  "Placement activity capacity triggers or detail indexes are missing from the migration.",
);
assert(
  activityLimits.includes("timeEntries: Object.freeze")
    && activityLimits.includes("limit: 500")
    && activityLimits.includes("checkIns: Object.freeze")
    && activityLimits.includes("documents: Object.freeze")
    && (activityLimits.match(/limit: 200/g) ?? []).length === 2,
  "Placement activity response capacities must remain explicit and shared.",
);
assert(
  sessionCapacityMigration.includes("idx_sessions_user_recency")
    && sessionCapacityMigration.includes("idx_sessions_expires_at")
    && sessionCapacityMigration.includes("idx_sessions_last_seen_at")
    && sessionCapacityMigration.includes("sessions_user_capacity")
    && sessionCapacityMigration.includes("OFFSET 9"),
  "Active-session capacity or cleanup indexes are missing from the migration.",
);
assert(
  userCapacityMigration.includes("idx_users_school_listing")
    && userCapacityMigration.includes("users_school_capacity")
    && userCapacityMigration.includes("OFFSET 499")
    && userLimits.includes("MAX_USERS_PER_SCHOOL = 500"),
  "The complete administrative user directory must retain its explicit capacity boundary.",
);
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
  "node scripts/compact.mjs --confirm-maintenance",
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
  "node scripts/compact.mjs --confirm-maintenance",
  "`VECTOR_BACKUP_MAX_BYTES`",
  "reject an oversized input before hashing it",
]) {
  assert(backupAndRestore.includes(token), `Backup/restore runbook is missing ${token}`);
}
for (const token of [
  "scripts/release-cli.mjs accept",
  'candidate_root="$(mktemp -d)"',
  "outside the repository",
  "read-only root filesystem",
  "`SIGTERM`",
  "trivy image --scanners vuln",
  "trivy image --scanners secret",
  "runner-temporary directories",
]) {
  assert(releasing.includes(token), `Release runbook is missing ${token}`);
}
for (const token of [
  "`VECTOR_BOOTSTRAP_TIME_ZONE`",
  "`NODE_ENV=production` exactly",
  "aliases, different casing and surrounding whitespace fail startup",
  "Production startup rejects both an HTTP origin",
  "Port 4173 is the loopback",
  "Session cookies are HTTPS-only and scoped to `/api`",
  "`--env-file-if-exists=.env`",
  "blocks every workspace route",
  "`If-Match`",
  "`428 precondition_required`",
  "omit the entire query string",
  "static route template",
  "`/api/<unmatched>`",
  "`VECTOR_DEFAULT`",
  "`VECTOR_SESSION_IDLE_MINUTES`",
  "`VECTOR_BACKUP_MAX_BYTES`",
  "`VECTOR_REQUEST_TIMEOUT_MS`",
  "`VECTOR_HEADERS_TIMEOUT_MS`",
  "`VECTOR_KEEP_ALIVE_TIMEOUT_MS`",
  "`VECTOR_MAX_REQUESTS_PER_SOCKET`",
  "`VECTOR_SHUTDOWN_GRACE_MS`",
  "keep `stop_grace_period` longer",
  "`Vary: Accept-Encoding`",
  "API responses remain uncompressed",
  "Static application assets do not consume",
  "Server-enforced inactivity timeout",
  "at most ten active sessions",
  "Cohort coverage planning",
  "VECTOR 3.3 adds a forward-only collection-index migration",
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
  "node scripts/restore.mjs",
  "for removed_tool in npm npx corepack yarn yarnpkg pnpm pnpx",
  "Independent reproducibility gate",
  "subject-checksums: release/SHA256SUMS",
]) {
  assert(workflows.get("release.yml").includes(token), `release.yml is missing ${token}`);
}

console.log("VECTOR publication and distribution validation passed.");
