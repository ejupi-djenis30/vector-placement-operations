import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURES } from "../site/fixtures.mjs";
import {
  advanceStatus,
  filterPlacements,
  normalizePlacement,
  normalizePlacements,
  progress,
  summarize,
} from "../site/model.mjs";

test("summarizes placement work", () => {
  const summary = summarize(FIXTURES);
  assert.deepEqual(summary, { placements: 6, active: 2, review: 2, completion: 67 });
});

test("caps progress at one hundred percent", () => {
  assert.equal(progress({ loggedHours: 190, targetHours: 180 }), 100);
});

test("filters by status and human-readable fields", () => {
  assert.equal(filterPlacements(FIXTURES, { status: "review" }).length, 2);
  assert.equal(filterPlacements(FIXTURES, { query: "cobalt" })[0].student, "Sofia Marin");
});

test("advances status without moving beyond complete", () => {
  assert.equal(advanceStatus(FIXTURES[0]).status, "active");
  assert.equal(advanceStatus(FIXTURES[3]).status, "complete");
});

test("rejects malformed persisted placement records", () => {
  assert.throws(
    () => normalizePlacement({ ...FIXTURES[0], status: "toString" }),
    /Unknown status/,
  );
  assert.throws(
    () => normalizePlacement({ ...FIXTURES[0], end: "2026-02-31" }),
    /dates must be valid/,
  );
  assert.throws(
    () => normalizePlacement({ ...FIXTURES[0], end: "2026-01-01" }),
    /end on or after/,
  );
  const missingTrack = { ...FIXTURES[0] };
  delete missingTrack.track;
  assert.throws(() => normalizePlacement(missingTrack), /missing track/);
});

test("rejects duplicate placement ids and unknown status transitions", () => {
  assert.throws(() => normalizePlacements([FIXTURES[0], FIXTURES[0]]), /ids must be unique/);
  assert.throws(() => advanceStatus({ ...FIXTURES[0], status: "unknown" }), /Unknown status/);
});
