import { parse } from "parse5";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseHexColor(value) {
  assert(
    /^#[0-9a-f]{6}$/i.test(value),
    `Expected a six-digit hexadecimal colour, received ${value}.`,
  );
  return value
    .slice(1)
    .match(/.{2}/g)
    .map((channel) => Number.parseInt(channel, 16));
}

function channelLuminance(channel) {
  const value = channel / 255;
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color) {
  const [red, green, blue] = parseHexColor(color).map(channelLuminance);
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

export function blendHexColors(foreground, background, opacity) {
  assert(
    Number.isFinite(opacity) && opacity >= 0 && opacity <= 1,
    "Colour blending opacity must be between zero and one.",
  );
  const foregroundChannels = parseHexColor(foreground);
  const backgroundChannels = parseHexColor(background);
  const channels = foregroundChannels.map((channel, index) =>
    Math.round((channel * opacity) + (backgroundChannels[index] * (1 - opacity)))
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function blendHexColorLayers(background, layers) {
  return layers.reduce(
    (surface, { color, opacity }) => blendHexColors(color, surface, opacity),
    background,
  );
}

export function combinedOpacity(opacities) {
  assert(opacities.length > 0, "At least one opacity is required.");
  return 1 - opacities.reduce((transparency, opacity) => {
    assert(
      Number.isFinite(opacity) && opacity >= 0 && opacity <= 1,
      "Combined opacity values must be between zero and one.",
    );
    return transparency * (1 - opacity);
  }, 1);
}

export function splitCssTopLevelLayers(value) {
  assert(
    typeof value === "string" && value.trim().length > 0,
    "A non-empty CSS background value is required.",
  );

  const layers = [];
  let depth = 0;
  let escaped = false;
  let quote = "";
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      assert(depth > 0, `Unbalanced CSS background value: ${value}.`);
      depth -= 1;
      continue;
    }
    if (character !== "," || depth !== 0) continue;
    layers.push(value.slice(start, index).trim());
    start = index + 1;
  }

  assert(!quote && depth === 0, `Unbalanced CSS background value: ${value}.`);
  layers.push(value.slice(start).trim());
  assert(
    layers.every((layer) => layer.length > 0),
    `CSS background layers must not be empty: ${value}.`,
  );
  return layers;
}

export function assertCssBackgroundLayers(
  value,
  { expected, label = "CSS background" },
) {
  assert(
    Array.isArray(expected) && expected.length > 0,
    `${label} requires at least one expected layer.`,
  );
  const actual = splitCssTopLevelLayers(value);
  assert(
    actual.length === expected.length,
    `${label} must use exactly ${expected.length} top-level layers, found ${actual.length}.`,
  );
  expected.forEach((expectation, index) => {
    const layer = actual[index];
    let matches = layer === expectation;
    if (expectation instanceof RegExp) {
      expectation.lastIndex = 0;
      matches = expectation.test(layer);
    }
    assert(
      matches,
      `${label} layer ${index + 1} does not match its required structure: ${layer}.`,
    );
  });
  return actual;
}

export function cssSelectorDeclaration(styles, selector, property) {
  const cleanStyles = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = [];
  const propertyPattern = new RegExp(
    `(?:^|;)\\s*${escapeRegExp(property)}\\s*:\\s*([^;}]+)`,
    "gi",
  );

  for (const match of cleanStyles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((value) => value.trim());
    if (!selectors.includes(selector)) continue;
    for (const declaration of match[2].matchAll(propertyPattern)) {
      declarations.push(declaration[1].trim().replace(/\s+/g, " "));
    }
  }

  assert(
    declarations.length === 1,
    `Expected exactly one ${property} declaration for ${selector}, found ${declarations.length}.`,
  );
  return declarations[0];
}

export function assertCssSelectorDeclaration(
  styles,
  { expected, property, selector },
) {
  const actual = cssSelectorDeclaration(styles, selector, property);
  assert(
    actual === expected,
    `${selector} must set ${property} to ${expected}, received ${actual}.`,
  );
  return actual;
}

export function parseCssRgbaLayers(value) {
  const matches = [...value.matchAll(
    /rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d*\.?\d+)\s*\)/gi,
  )];
  assert(matches.length > 0, `Expected at least one RGBA colour layer, received ${value}.`);
  return matches.map((match) => {
    const channels = match.slice(1, 4).map(Number);
    const opacity = Number(match[4]);
    assert(
      channels.every((channel) =>
        Number.isInteger(channel) && channel >= 0 && channel <= 255
      )
        && Number.isFinite(opacity)
        && opacity >= 0
        && opacity <= 1,
      `Invalid RGBA colour layer in ${value}.`,
    );
    return {
      color: `#${channels
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("")}`,
      opacity,
    };
  });
}

export function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    Math.max(foregroundLuminance, backgroundLuminance) + 0.05
  ) / (
    Math.min(foregroundLuminance, backgroundLuminance) + 0.05
  );
}

export function assertContrastRatio(
  foreground,
  background,
  { label = "Colour pair", minimum = 4.5 } = {},
) {
  const ratio = contrastRatio(foreground, background);
  assert(
    ratio >= minimum,
    `${label} contrast ratio ${ratio.toFixed(2)}:1 is below ${minimum.toFixed(2)}:1.`,
  );
  return ratio;
}

function visitHtml(node, visitor) {
  visitor(node);
  for (const child of node.childNodes ?? []) visitHtml(child, visitor);
}

export function assertRobotsTxt(robots, { basePath, sitemapUrl }) {
  assert(
    /^\/[^?#]*\/$/.test(basePath),
    "The canonical project base path must start and end with a slash.",
  );
  assert(
    robots === `User-agent: *\nAllow: ${basePath}\n\nSitemap: ${sitemapUrl}\n`,
    "robots.txt must use the canonical project path and sitemap URL.",
  );
}

export function assertSitemapXml(sitemap, { pageUrl }) {
  const expected = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    "  <url>",
    `    <loc>${pageUrl}</loc>`,
    "  </url>",
    "</urlset>",
    "",
  ].join("\n");
  assert(sitemap === expected, "sitemap.xml must contain only the canonical project page URL.");
}

export function assertSecurityTxt(security, {
  canonicalUrl,
  contactUrl,
  now = Date.now(),
  policyUrl,
}) {
  assert(!security.includes("\r"), "security.txt must use canonical LF line endings.");
  assert(security.endsWith("\n"), "security.txt must end with a newline.");
  assert(
    !/mailto:|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(security),
    "security.txt must not publish an email address.",
  );

  const lines = security.slice(0, -1).split("\n");
  const fields = lines.map((line) => {
    const separator = line.indexOf(": ");
    assert(separator > 0, `security.txt contains a malformed field: ${line}`);
    return [line.slice(0, separator), line.slice(separator + 2)];
  });
  assert(
    fields.map(([name]) => name).join("\n")
      === ["Contact", "Expires", "Preferred-Languages", "Canonical", "Policy"].join("\n"),
    "security.txt must contain the canonical field set and order.",
  );

  const values = Object.fromEntries(fields);
  assert(values.Contact === contactUrl, "security.txt Contact must use private vulnerability reporting.");
  assert(values["Preferred-Languages"] === "en", "security.txt must prefer English.");
  assert(values.Canonical === canonicalUrl, "security.txt Canonical URL is not project-scoped.");
  assert(values.Policy === policyUrl, "security.txt Policy URL is not canonical.");
  assert(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(values.Expires),
    "security.txt Expires must use a UTC RFC 3339 timestamp.",
  );

  const expires = Date.parse(values.Expires);
  const referenceTime = Number(now);
  const maximumLifetime = 366 * 24 * 60 * 60 * 1000;
  assert(Number.isFinite(referenceTime), "security.txt validation requires a valid reference time.");
  assert(expires > referenceTime, "security.txt Expires must remain in the future.");
  assert(
    expires <= referenceTime + maximumLifetime,
    "security.txt Expires must be no more than 366 days in the future.",
  );
}

export function assertExternalScriptsOnly(html, name) {
  const parseErrors = [];
  const document = parse(html, {
    onParseError: (error) => parseErrors.push(error),
  });
  if (parseErrors.length > 0) {
    const first = parseErrors[0];
    throw new Error(
      `${name} contains invalid HTML (${first.code} at ${first.startLine}:${first.startCol}).`,
    );
  }

  visitHtml(document, (node) => {
    if (!Array.isArray(node.attrs)) return;
    for (const attribute of node.attrs) {
      assert(!attribute.name.startsWith("on"), `${name} contains an inline event handler.`);
      assert(attribute.name !== "style", `${name} contains an inline style.`);
    }
    if (node.tagName !== "script") return;
    const source = node.attrs.find((attribute) => attribute.name === "src");
    assert(source?.value.trim(), `${name} contains an inline script.`);
    const scriptText = (node.childNodes ?? [])
      .map((child) => child.nodeName === "#text" ? child.value : "non-text-script-content")
      .join("");
    assert(scriptText.trim() === "", `${name} contains script text.`);
  });
}
