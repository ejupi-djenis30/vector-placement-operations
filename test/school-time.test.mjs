import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIanaTimeZone,
  dateAtInstantInTimeZone,
} from "../server/school-time.mjs";

test("school dates follow the configured IANA zone across midnight and DST", () => {
  assert.equal(assertIanaTimeZone("Europe/Zurich"), "Europe/Zurich");
  assert.equal(
    dateAtInstantInTimeZone("2026-03-29T22:30:00.000Z", "Europe/Zurich"),
    "2026-03-30",
  );
  assert.equal(
    dateAtInstantInTimeZone("2026-07-26T12:30:00.000Z", "Pacific/Auckland"),
    "2026-07-27",
  );
  assert.equal(
    dateAtInstantInTimeZone("2026-10-25T00:30:00.000Z", "Europe/Zurich"),
    "2026-10-25",
  );
  assert.throws(() => assertIanaTimeZone("Zurich-ish"), /valid IANA time zone/);
});
