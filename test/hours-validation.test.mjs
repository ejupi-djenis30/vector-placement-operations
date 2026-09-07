import assert from "node:assert/strict";
import test from "node:test";
import { hoursToMinutes } from "../server/validation.mjs";

test("positive hours must not round down to a zero-minute record", () => {
  for (const hours of [Number.MIN_VALUE, 1e-12, 1e-9, 1e-8]) {
    assert.throws(() => hoursToMinutes(hours), { statusCode: 422, code: "invalid_hours" });
  }
});

test("whole-minute conversion keeps valid boundaries and floating-point tolerance", () => {
  assert.equal(hoursToMinutes(1 / 60), 1);
  assert.equal(hoursToMinutes(1.25), 75);
  assert.equal(hoursToMinutes(2000), 120_000);
  assert.equal(hoursToMinutes(0.1 + 0.2), 18);
  assert.throws(() => hoursToMinutes(1 / 7), /whole minutes/);
  for (const hours of [0, -1, Infinity, NaN, 2001]) {
    assert.throws(() => hoursToMinutes(hours), { statusCode: 422, code: "invalid_hours" });
  }
});
