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

const [html, styles, app, readme, security, packageText, socialPreview, socialPreviewPng] = await Promise.all([
  readFile(new URL("index.html", siteRoot), "utf8"),
  readFile(new URL("styles.css", siteRoot), "utf8"),
  readFile(new URL("app.mjs", siteRoot), "utf8"),
  readFile(new URL("README.md", repositoryRoot), "utf8"),
  readFile(new URL("SECURITY.md", repositoryRoot), "utf8"),
  readFile(new URL("package.json", repositoryRoot), "utf8"),
  readFile(new URL("assets/social-preview.svg", siteRoot), "utf8"),
  readFile(new URL("assets/social-preview.png", siteRoot)),
]);
const packageJson = JSON.parse(packageText);

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
assert(
  socialPreviewPng.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && socialPreviewPng.readUInt32BE(16) === 1200
    && socialPreviewPng.readUInt32BE(20) === 630,
  "The social preview PNG must be exactly 1200 × 630.",
);
assert(!/\.style\s*\./.test(app), "Application code must not create CSP-blocked inline styles.");
assert(/<progress\b/.test(app), "The placement progress indicator must use the native progress element.");

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
assert(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(repositoryText), "A personal or operational email address is present.");
assert(!/[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]/i.test(repositoryText), "An Italian tax identifier is present.");
assert(!/\+\d[\d .()-]{7,}\d/.test(repositoryText), "A phone number is present.");
assert(
  !/<video\b|\bposter\s*=|\.(?:mp4|webm|mov|m4v|avi)\b|demo[- ]?video/i.test(repositoryText),
  "The public presentation must not embed or reference a video.",
);

assert(packageJson.name === "vector-placement-operations", "package.json must use the VECTOR package name.");
assert(packageJson.homepage === PAGE_URL, "package.json must declare the public homepage.");
assert(packageJson.license === "MIT", "package.json must declare the MIT license.");
assert(/Released under the \[MIT License\]\(LICENSE\)\./i.test(readme), "README.md must link to the MIT license.");
assert(/\bMIT License\b/i.test(presentationText), "The public presentation must state the MIT license.");

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
for (const token of ["pull_request:", "contents: read", "persist-credentials: false", "npm run check"]) {
  assert(ciWorkflow.includes(token), `ci.yml is missing ${token}`);
}

for (const [name, workflow] of workflows) {
  assert(!/pull_request_target\s*:/i.test(workflow), `${name} must not run privileged code from pull requests.`);
  assert(!/contents:\s*write|permissions:\s*write-all/i.test(workflow), `${name} grants broader write access than required.`);
  for (const match of workflow.matchAll(/\buses:\s*([^\s#]+)/g)) {
    assert(/@[0-9a-f]{40}$/i.test(match[1]), `${name} must pin ${match[1]} to a full commit SHA.`);
  }
}

console.log("VECTOR publication validation passed.");
