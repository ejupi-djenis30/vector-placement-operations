import { parse } from "parse5";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function visitHtml(node, visitor) {
  visitor(node);
  for (const child of node.childNodes ?? []) visitHtml(child, visitor);
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
