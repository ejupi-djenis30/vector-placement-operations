import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCssSelectorDeclaration,
  assertContrastRatio,
  assertExternalScriptsOnly,
  assertRobotsTxt,
  assertSecurityTxt,
  assertSitemapXml,
  blendHexColorLayers,
  blendHexColors,
  combinedOpacity,
  contrastRatio,
} from "../scripts/site-validation.mjs";

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

test("site validation accepts external scripts with standards-compliant closing whitespace", () => {
  assert.doesNotThrow(() => assertExternalScriptsOnly(
    document('<script type="module" src="app.mjs"></script >'),
    "valid.html",
  ));
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
