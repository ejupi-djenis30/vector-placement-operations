import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceUi } from "../site/app/workspace-ui.mjs";

function workspaceUi() {
  const element = (tag, options = {}, children = []) => ({
    tag,
    ...options,
    children,
  });
  return createWorkspaceUi({
    document: {},
    window: {},
    app: {},
    element,
    request: async () => ({}),
    onError() {},
  });
}

test("simple inputs preserve declared guidance and required state", () => {
  const ui = workspaceUi();
  assert.deepEqual(
    ui.simpleInput("search", "placement.updated", {
      placeholder: "e.g. placement.updated",
      required: true,
    }),
    {
      tag: "input",
      type: "search",
      value: "placement.updated",
      placeholder: "e.g. placement.updated",
      required: true,
      children: [],
    },
  );
});

test("simple inputs do not emit an empty placeholder attribute", () => {
  const ui = workspaceUi();
  const input = ui.simpleInput("date", "2026-08-01");
  assert.equal(input.required, false);
  assert.equal(Object.hasOwn(input, "placeholder"), false);
});
