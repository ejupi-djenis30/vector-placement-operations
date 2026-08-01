import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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
  contrastRatio,
  normalizedElementText,
} from "../scripts/site-validation.mjs";
import { ROLE_DATA_SCOPES } from "../server/rbac.mjs";

const document = (body) => `<!doctype html><html><head><title>Test</title></head><body>${body}</body></html>`;
const pageUrl = "https://ejupi-djenis30.github.io/vector-placement-operations/";
const basePath = "/vector-placement-operations/";
const sitemapUrl = `${pageUrl}sitemap.xml`;
const canonicalSecurityUrl = `${pageUrl}.well-known/security.txt`;
const contactUrl =
  "https://github.com/ejupi-djenis30/vector-placement-operations/security/advisories/new";
const policyUrl =
  "https://github.com/ejupi-djenis30/vector-placement-operations/security/policy";
const validationTime = Date.parse("2026-07-29T12:00:00Z");

const validRobots = `User-agent: *\nAllow: ${basePath}\n\nSitemap: ${sitemapUrl}\n`;
const validSitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  "  <url>",
  `    <loc>${pageUrl}</loc>`,
  "  </url>",
  "</urlset>",
  "",
].join("\n");
const validSecurity = [
  `Contact: ${contactUrl}`,
  "Expires: 2027-07-29T00:00:00Z",
  "Preferred-Languages: en",
  `Canonical: ${canonicalSecurityUrl}`,
  `Policy: ${policyUrl}`,
  "",
].join("\n");

test("CSS block validation ignores comments and strings but rejects structural truncation", () => {
  assert.equal(
    assertBalancedCssBlocks(
      '.card { content: "}"; /* { inert } */ color: CanvasText; }',
      "fixture CSS",
    ),
    true,
  );
  assert.throws(
    () => assertBalancedCssBlocks("@media (max-width: 30rem) { .card { color: red; }", "fixture CSS"),
    /unclosed block opened at line 1/i,
  );
  assert.throws(
    () => assertBalancedCssBlocks(".card { color: red; }}", "fixture CSS"),
    /unmatched closing block at line 1/i,
  );
});

test("marketing heading line breaks preserve searchable and copyable word boundaries", () => {
  const marketing = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  for (const [id, expected] of [
    ["hero-title", "Keep each placement accountable."],
    ["product-title", "See the programme. Act on the gap."],
    ["workflow-title", "One workflow. Each decision traceable."],
    ["controls-title", "Straightforward to operate. Explicit where it matters."],
    ["self-host-title", "A public product page. A private workspace."],
  ]) {
    assert.equal(normalizedElementText(marketing, id), expected);
  }
});

test("public role claims stay aligned with the server RBAC scope matrix", () => {
  const marketing = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const claims = assertRoleScopeClaims(marketing, ROLE_DATA_SCOPES);
  assert.equal(claims.tutor.scope, "assigned");
  assert.equal(claims.viewer.scope, "school");

  assert.throws(
    () => assertRoleScopeClaims(
      marketing.replace(
        "Reads the school-wide placement picture in read-only mode.",
        "Reads the explicitly granted school-wide or assignment-scoped picture.",
      ),
      ROLE_DATA_SCOPES,
    ),
    /viewer claim.*school-wide read-only scope without assigned scope/i,
  );
  assert.throws(
    () => assertRoleScopeClaims(
      marketing.replace(
        'data-role="viewer" data-scope="school"',
        'data-role="viewer" data-scope="assigned"',
      ),
      ROLE_DATA_SCOPES,
    ),
    /viewer must use school scope/i,
  );
  assert.throws(
    () => assertRoleScopeClaims(
      marketing.replace(
        "Owns users, branding, retention and governed corrections.",
        "Owns users, branding, retention, recovery and governed corrections.",
      ),
      ROLE_DATA_SCOPES,
    ),
    /administrator claim.*host-level recovery permissions/i,
  );
});

test("site validation accepts external scripts with standards-compliant closing whitespace", () => {
  assert.doesNotThrow(() => assertExternalScriptsOnly(
    document('<script type="module" src="app.mjs"></script >'),
    "valid.html",
  ));
});

test("site validation permits only explicitly allowed inert structured data inline", () => {
  assert.doesNotThrow(() => assertExternalScriptsOnly(
    document('<script type="application/ld+json">{"@type":"SoftwareApplication"}</script>'),
    "structured.html",
    { allowedInlineScriptTypes: ["application/ld+json"] },
  ));
  assert.throws(
    () => assertExternalScriptsOnly(
      document("<script>globalThis.compromised = true</script>"),
      "executable.html",
      { allowedInlineScriptTypes: ["application/ld+json"] },
    ),
    /inline script/i,
  );
});

test("site validation rejects inline code, event handlers, styles and malformed script tags", () => {
  for (const [html, message] of [
    [document("<script>globalThis.compromised = true</script>"), /inline script/i],
    [document('<script src="app.mjs">globalThis.compromised = true</script>'), /script text/i],
    [document("<img ONERROR=alert(1)>"), /event handler/i],
    [document('<main style="display:none"></main>'), /inline style/i],
    [document('<script src="app.mjs"></script ignored>'), /invalid HTML/i],
  ]) {
    assert.throws(() => assertExternalScriptsOnly(html, "invalid.html"), message);
  }
});

test("publication metadata accepts the canonical project-scoped contracts", () => {
  assert.doesNotThrow(() => assertRobotsTxt(validRobots, { basePath, sitemapUrl }));
  assert.doesNotThrow(() => assertSitemapXml(validSitemap, { pageUrl }));
  assert.doesNotThrow(() => assertSecurityTxt(validSecurity, {
    canonicalUrl: canonicalSecurityUrl,
    contactUrl,
    now: validationTime,
    policyUrl,
  }));
});

test("publication metadata rejects root-scoped, non-canonical and stale values", () => {
  assert.throws(
    () => assertRobotsTxt(validRobots.replace(basePath, "/"), { basePath, sitemapUrl }),
    /canonical project path/i,
  );
  assert.throws(
    () => assertSitemapXml(validSitemap.replace(pageUrl, "https://example.test/"), { pageUrl }),
    /canonical project page URL/i,
  );
  assert.throws(
    () => assertSecurityTxt(
      validSecurity.replace(contactUrl, "mailto:security@example.test"),
      {
        canonicalUrl: canonicalSecurityUrl,
        contactUrl,
        now: validationTime,
        policyUrl,
      },
    ),
    /email address/i,
  );
  assert.throws(
    () => assertSecurityTxt(
      validSecurity.replace("2027-07-29T00:00:00Z", "2026-07-29T00:00:00Z"),
      {
        canonicalUrl: canonicalSecurityUrl,
        contactUrl,
        now: validationTime,
        policyUrl,
      },
    ),
    /remain in the future/i,
  );
  assert.throws(
    () => assertSecurityTxt(
      validSecurity.replace(canonicalSecurityUrl, `${pageUrl}security.txt`),
      {
        canonicalUrl: canonicalSecurityUrl,
        contactUrl,
        now: validationTime,
        policyUrl,
      },
    ),
    /Canonical URL is not project-scoped/i,
  );
});

test("publication palette keeps normal text above WCAG AA across both grid intersections", () => {
  const cream = "#f5efe5";
  const ink = "#17324d";
  const bodyGrid = blendHexColorLayers(cream, [
    { color: ink, opacity: 0.04 },
    { color: ink, opacity: 0.04 },
  ]);
  const signalGridOpacity = combinedOpacity([0.055, 0.055]) * 0.9;
  const signalGrid = blendHexColors(cream, ink, signalGridOpacity);
  const signalMeter = blendHexColors(cream, signalGrid, 0.06);

  assert.equal(bodyGrid, "#e3e0d9");
  assert.equal(signalGrid, "#2c445c");
  assert.equal(signalMeter, "#384e64");
  assert.ok(contrastRatio("#56626b", bodyGrid) >= 4.5);
  assert.ok(contrastRatio("#ffa599", signalMeter) >= 4.5);
  assert.throws(
    () => assertContrastRatio("#626e77", bodyGrid, {
      label: "Previous muted marketing copy",
      minimum: 4.5,
    }),
    /contrast ratio 3\.97:1 is below 4\.50:1/,
  );
  assert.throws(
    () => assertContrastRatio("#ff8372", signalMeter, {
      label: "Previous signal-meter value",
      minimum: 4.5,
    }),
    /contrast ratio 3\.58:1 is below 4\.50:1/,
  );
});

test("publication colour contracts reject a later selector override", () => {
  const contract = [
    ":root { --muted: #56626b; }",
    ".lead { color: var(--muted); }",
    ".signal-meter b { color: var(--coral-bright); }",
  ].join("\n");

  assert.equal(
    assertCssSelectorDeclaration(contract, {
      expected: "var(--muted)",
      property: "color",
      selector: ".lead",
    }),
    "var(--muted)",
  );
  assert.throws(
    () => assertCssSelectorDeclaration(
      `${contract}\n.other, .lead { color: #ffffff; }`,
      {
        expected: "var(--muted)",
        property: "color",
        selector: ".lead",
      },
    ),
    /exactly one color declaration.*found 2/i,
  );
  assert.throws(
    () => assertCssSelectorDeclaration(
      contract.replace("var(--muted)", "#626e77"),
      {
        expected: "var(--muted)",
        property: "color",
        selector: ".lead",
      },
    ),
    /must set color to var\(--muted\)/i,
  );
});

test("publication background contracts reject opaque and additional layers", () => {
  const verticalGrid =
    /^linear-gradient\(\s*rgba\([^)]*\)\s+1px\s*,\s*transparent\s+1px\s*\)$/i;
  const horizontalGrid =
    /^linear-gradient\(\s*90deg\s*,\s*rgba\([^)]*\)\s+1px\s*,\s*transparent\s+1px\s*\)$/i;
  const body = [
    "linear-gradient(rgba(23, 50, 77, .04) 1px, transparent 1px)",
    "linear-gradient(90deg, rgba(23, 50, 77, .04) 1px, transparent 1px)",
    "var(--cream)",
  ].join(", ");
  const meter = "rgba(245, 239, 229, .06)";

  assert.deepEqual(
    assertCssBackgroundLayers(body, {
      expected: [verticalGrid, horizontalGrid, "var(--cream)"],
      label: "Body background",
    }),
    [
      "linear-gradient(rgba(23, 50, 77, .04) 1px, transparent 1px)",
      "linear-gradient(90deg, rgba(23, 50, 77, .04) 1px, transparent 1px)",
      "var(--cream)",
    ],
  );
  assert.throws(
    () => assertCssBackgroundLayers(
      `linear-gradient(#000, #000), ${body}`,
      {
        expected: [verticalGrid, horizontalGrid, "var(--cream)"],
        label: "Body background",
      },
    ),
    /exactly 3 top-level layers, found 4/i,
  );
  assert.throws(
    () => assertCssBackgroundLayers(
      body.replace("transparent 1px", "#000 1px"),
      {
        expected: [verticalGrid, horizontalGrid, "var(--cream)"],
        label: "Body background",
      },
    ),
    /layer 1 does not match its required structure/i,
  );
  assert.throws(
    () => assertCssBackgroundLayers(
      `linear-gradient(#fff, #fff), ${meter}`,
      {
        expected: [/^rgba\([^)]*\)$/i],
        label: "Signal-meter background",
      },
    ),
    /exactly 1 top-level layers, found 2/i,
  );
});
