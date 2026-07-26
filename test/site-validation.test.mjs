import assert from "node:assert/strict";
import test from "node:test";
import { assertExternalScriptsOnly } from "../scripts/site-validation.mjs";

const document = (body) => `<!doctype html><html><head><title>Test</title></head><body>${body}</body></html>`;

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
