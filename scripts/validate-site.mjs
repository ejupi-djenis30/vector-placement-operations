import { readFile, readdir, stat } from "node:fs/promises";

const PAGE_URL = "https://ejupi-djenis30.github.io/vector-placement-operations/";
const SOCIAL_IMAGE_URL = `${PAGE_URL}assets/social-preview.png`;
const siteRoot = new URL("../site/", import.meta.url);
const repositoryRoot = new URL("../", siteRoot);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && [".git", "node_modules"].includes(entry.name)) continue;
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await listFiles(new URL(`${entry.name}/`, directory), `${relativePath}/`));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

const [html, styles, app, robots, readme, security, packageText, releasePolicyText, socialPreview, socialPreviewPng] = await Promise.all([
  readFile(new URL("index.html", siteRoot), "utf8"),
  readFile(new URL("styles.css", siteRoot), "utf8"),
  readFile(new URL("app.mjs", siteRoot), "utf8"),
  readFile(new URL("robots.txt", siteRoot), "utf8"),
  readFile(new URL("README.md", repositoryRoot), "utf8"),
  readFile(new URL("SECURITY.md", repositoryRoot), "utf8"),
  readFile(new URL("package.json", repositoryRoot), "utf8"),
  readFile(new URL("release-policy.json", repositoryRoot), "utf8"),
  readFile(new URL("assets/social-preview.svg", siteRoot), "utf8"),
  readFile(new URL("assets/social-preview.png", siteRoot)),
]);
const packageJson = JSON.parse(packageText);
const releasePolicy = JSON.parse(releasePolicyText);

for (const file of [
  "styles.css",
  "app.mjs",
  "model.mjs",
  "fixtures.mjs",
  "assets/vector-mark.svg",
  "assets/vector-lockup.svg",
  "assets/social-preview.svg",
  "assets/social-preview.png",
]) {
  await stat(new URL(file, siteRoot));
}

for (const token of [
  'lang="en"',
  "<main",
  "Synthetic data",
  "aria-label",
  "data-placement-list",
  `rel="canonical" href="${PAGE_URL}"`,
  `property="og:url" content="${PAGE_URL}"`,
  `property="og:image" content="${SOCIAL_IMAGE_URL}"`,
  'property="og:image:type" content="image/png"',
  'property="og:image:width" content="1200"',
  'property="og:image:height" content="630"',
  'name="twitter:card" content="summary_large_image"',
  `name="twitter:image" content="${SOCIAL_IMAGE_URL}"`,
  "media-src 'none'",
  "connect-src 'none'",
]) {
  assert(html.includes(token), `index.html is missing ${token}`);
}

const fixtures = await readFile(new URL("fixtures.mjs", siteRoot), "utf8");
assert(
  !/\b(?:password|email|phone)\b/i.test(fixtures),
  "Fixture data must not contain contact or credential fields.",
);
assert(!/(?:src|href)="\//.test(html), "Site assets must remain relative to the Pages project root.");
const readmeLinks = [...readme.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)]
  .map(([, link]) => new URL(link).href);
assert(
  readmeLinks.some((link) => link === PAGE_URL),
  "The public Pages URL must appear as an exact README link destination.",
);

assert(
  /<svg\b[^>]*\bwidth="1200"[^>]*\bheight="630"[^>]*\bviewBox="0 0 1200 630"/i.test(socialPreview),
  "The social preview must be a 1200 × 630 SVG with a matching viewBox.",
);
assert(/<title\b/i.test(socialPreview) && /<desc\b/i.test(socialPreview), "The social preview must include accessible text.");
const previewMetricCards = [...socialPreview.matchAll(
  /<rect x="(\d+)" y="76" width="(\d+)" height="108" rx="12"/g,
)].map(([, x, width]) => ({ x: Number(x), width: Number(width) }));
assert(previewMetricCards.length === 2, "The social preview must contain exactly two metric cards.");
assert(
  previewMetricCards[0].width === previewMetricCards[1].width,
  "The social preview metric cards must have equal widths.",
);
assert(
  previewMetricCards[1].x - (previewMetricCards[0].x + previewMetricCards[0].width) === 18,
  "The social preview metric cards must retain the designed 18 px gutter.",
);
assert(
  socialPreviewPng.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && socialPreviewPng.readUInt32BE(16) === 1200
    && socialPreviewPng.readUInt32BE(20) === 630,
  "The social preview PNG must be exactly 1200 × 630.",
);
assert(!/\.style\s*\./.test(app), "Application code must not create CSP-blocked inline styles.");
assert(/<progress\b/.test(app), "The placement progress indicator must use the native progress element.");
assert(
  robots === "User-agent: *\nAllow: /\n",
  "robots.txt must explicitly allow crawlers with a stable UTF-8 payload.",
);

for (const token of [
  "--coral-bright:#ff7563",
  ".metrics .metric-accent>span,.metrics .metric-accent small{color:var(--paper)}",
  "color:rgba(245,239,229,.7)",
  "color:rgba(245,239,229,.64)",
]) {
  assert(styles.includes(token), `styles.css is missing the contrast-safe token ${token}`);
}

const presentationText = `${html}\n${styles}\n${readme}\n${security}`;
const retiredCopy = ["publication", " hold", "local", " preview", "held for", " history cleanup"];
const retiredPhrases = [
  `${retiredCopy[0]}${retiredCopy[1]}`,
  `${retiredCopy[2]}${retiredCopy[3]}`,
  `${retiredCopy[4]}${retiredCopy[5]}`,
];
for (const phrase of retiredPhrases) {
  assert(!presentationText.toLocaleLowerCase("en").includes(phrase), `Public copy still contains a retired release-state phrase: ${phrase}`);
}

const repositoryFiles = await listFiles(repositoryRoot);
for (const file of repositoryFiles) {
  assert(!/(?:^|\/)(?:PCTO\.sql|[^/]+\.docx)$/i.test(file), `Sensitive legacy artifact found: ${file}`);
  assert(!/(?:video|poster)/i.test(file), `Retired media asset found: ${file}`);
  assert(!/\.(?:mp4|webm|mov|m4v|avi)$/i.test(file), `Video asset found: ${file}`);
}

const textFiles = repositoryFiles.filter((file) =>
  /\.(?:css|html?|js|mjs|json|md|svg|txt|ya?ml)$/i.test(file)
  && file !== "scripts/validate-site.mjs"
);
const repositoryText = (await Promise.all(
  textFiles.map((file) => readFile(new URL(file.replaceAll("\\", "/"), repositoryRoot), "utf8")),
)).join("\n");
const repositoryEmails = [...repositoryText.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
  .map(([email]) => email.toLocaleLowerCase("en"));
assert(
  repositoryEmails.every((email) => email === releasePolicy.tagger.email.toLocaleLowerCase("en")),
  "A personal or operational email address is present.",
);
assert(!/[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]/i.test(repositoryText), "An Italian tax identifier is present.");
assert(!/\+\d[\d .()-]{7,}\d/.test(repositoryText), "A phone number is present.");
assert(
  !/<video\b|\bposter\s*=|\.(?:mp4|webm|mov|m4v|avi)\b|demo[- ]?video/i.test(repositoryText),
  "The public presentation must not embed or reference a video.",
);

assert(packageJson.name === "vector-placement-operations", "package.json must use the VECTOR package name.");
assert(packageJson.homepage === PAGE_URL, "package.json must declare the public homepage.");
assert(packageJson.license === "MIT", "package.json must declare the MIT license.");
assert(packageJson.scripts?.["test:e2e"] === "playwright test", "package.json must expose the browser test command.");
assert(
  /^\d+\.\d+\.\d+$/.test(packageJson.devDependencies?.["@playwright/test"] ?? ""),
  "@playwright/test must use an exact version without a floating range.",
);
assert(/Released under the \[MIT License\]\(LICENSE\)\./i.test(readme), "README.md must link to the MIT license.");
assert(/\bMIT License\b/i.test(presentationText), "The public presentation must state the MIT license.");

for (const file of [
  "playwright.config.mjs",
  "scripts/serve-site.mjs",
  "e2e/workspace.spec.mjs",
]) {
  await stat(new URL(file, repositoryRoot));
}

const siteServer = await readFile(new URL("scripts/serve-site.mjs", repositoryRoot), "utf8");
assert(
  siteServer.includes('[".txt", "text/plain; charset=utf-8"]'),
  "The local publication server must serve robots.txt as UTF-8 plain text.",
);

const rootEntries = await readdir(repositoryRoot, { withFileTypes: true });
assert(
  rootEntries.some((entry) => entry.isFile() && /^licen[cs]e(?:\.|$)/i.test(entry.name)),
  "The MIT license file is missing.",
);

const workflowRoot = new URL(".github/workflows/", repositoryRoot);
const workflows = new Map();
for (const entry of await readdir(workflowRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
  workflows.set(entry.name, await readFile(new URL(entry.name, workflowRoot), "utf8"));
}

const pagesWorkflow = workflows.get("pages.yml");
assert(pagesWorkflow, "A dedicated Pages workflow is required.");
for (const token of [
  "branches: [main]",
  "workflow_dispatch:",
  "contents: read",
  "persist-credentials: false",
  "npm run check",
  "runs-on: ubuntu-24.04",
  "timeout-minutes: 20",
  "node-version: 24.16.0",
  "npx --no-install playwright install --with-deps chromium",
  "npm run test:e2e",
  "pages: write",
  "enablement: true",
  "actions/configure-pages@",
  "actions/upload-pages-artifact@",
  "path: site",
  "needs: build",
  "pages: write",
  "id-token: write",
  "name: github-pages",
  "actions/deploy-pages@",
]) {
  assert(pagesWorkflow.includes(token), `pages.yml is missing ${token}`);
}

const ciWorkflow = workflows.get("ci.yml");
assert(ciWorkflow, "A pull-request CI workflow is required.");
for (const token of [
  "pull_request:",
  "contents: read",
  "persist-credentials: false",
  "npm run check",
  "name: Chromium E2E",
  "runs-on: ubuntu-24.04",
  "node-version: 24.16.0",
  "npx --no-install playwright install --with-deps chromium",
  "npm run test:e2e",
]) {
  assert(ciWorkflow.includes(token), `ci.yml is missing ${token}`);
}

for (const [name, workflow] of workflows) {
  assert(!/pull_request_target\s*:/i.test(workflow), `${name} must not run privileged code from pull requests.`);
  assert(!/permissions:\s*write-all/i.test(workflow), `${name} grants broader write access than required.`);
  const contentWriteGrants = [...workflow.matchAll(/contents:\s*write/g)];
  if (name === "release.yml") {
    assert(contentWriteGrants.length === 1, "release.yml must grant contents: write only to its publish job.");
    assert(
      workflow.indexOf("contents: write") > workflow.indexOf("publish:")
        && workflow.indexOf("contents: write") < workflow.indexOf("Attest checksummed release assets"),
      "release.yml grants publication permission outside the publish job.",
    );
  } else {
    assert(contentWriteGrants.length === 0, `${name} grants content write access.`);
  }
  for (const match of workflow.matchAll(/\buses:\s*([^\s#]+)/g)) {
    assert(/@[0-9a-f]{40}$/i.test(match[1]), `${name} must pin ${match[1]} to a full commit SHA.`);
  }
}

console.log("VECTOR publication validation passed.");
