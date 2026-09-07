import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../scripts/cli-args.mjs";

test("inline CLI values preserve every equals sign after the option name", () => {
  const contract = { strings: ["file", "email", "name"] };
  for (const [key, value] of [
    ["file", "backups/school=alpha=2026.sqlite"],
    ["file", "C:\\Backups\\school=alpha=2026.sqlite"],
    ["file", "=snapshot.sqlite"],
    ["email", "school=admin@example.test"],
    ["name", "School = Operations"],
  ]) {
    assert.deepEqual(parseArgs([`--${key}=${value}`], contract), { [key]: value });
    assert.deepEqual(parseArgs([`--${key}`, value], contract), { [key]: value });
  }
});

test("equals signs do not bypass strict option validation", () => {
  const contract = { strings: ["file"], booleans: ["confirm-empty"] };
  assert.throws(() => parseArgs(["--unknown=a=b"], contract), /Unknown argument/);
  assert.throws(() => parseArgs(["--confirm-empty=="], contract), /does not accept a value/);
  assert.throws(() => parseArgs(["--file=a=b", "--file=c=d"], contract), /Duplicate argument/);
  assert.deepEqual(parseArgs(["--file="], contract), { file: "" });
});
