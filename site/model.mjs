export const STATUS = Object.freeze({
  planned: { label: "Planned", tone: "slate" },
  active: { label: "In progress", tone: "blue" },
  review: { label: "Needs review", tone: "coral" },
  complete: { label: "Complete", tone: "green" },
});

function isIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function normalizePlacement(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Placement must be an object.");
  }

  const textFields = ["id", "student", "company", "supervisor", "start", "end", "status", "track"];
  const normalized = { ...record };
  for (const key of textFields) {
    if (typeof record[key] !== "string" || !record[key].trim()) {
      throw new Error(`Placement is missing ${key}.`);
    }
    normalized[key] = record[key].trim();
  }
  if (!Object.hasOwn(STATUS, normalized.status)) throw new Error(`Unknown status: ${normalized.status}`);
  if (!isIsoDate(normalized.start) || !isIsoDate(normalized.end) || normalized.end < normalized.start) {
    throw new Error("Placement dates must be valid and end on or after the start date.");
  }
  const targetHours = Number(record.targetHours);
  const loggedHours = Number(record.loggedHours);
  if (!Number.isFinite(targetHours) || targetHours <= 0) throw new Error("targetHours must be positive.");
  if (!Number.isFinite(loggedHours) || loggedHours < 0) throw new Error("loggedHours cannot be negative.");
  return { ...normalized, targetHours, loggedHours };
}

export function normalizePlacements(records) {
  if (!Array.isArray(records)) throw new Error("Placements must be an array.");
  const normalized = records.map(normalizePlacement);
  const ids = new Set(normalized.map((record) => record.id));
  if (ids.size !== normalized.length) throw new Error("Placement ids must be unique.");
  return normalized;
}

export function progress(record) {
  const value = Math.round((record.loggedHours / record.targetHours) * 100);
  return Math.max(0, Math.min(100, value));
}

export function summarize(records) {
  const normalized = normalizePlacements(records);
  const target = normalized.reduce((sum, record) => sum + record.targetHours, 0);
  const logged = normalized.reduce((sum, record) => sum + record.loggedHours, 0);
  return {
    placements: normalized.length,
    active: normalized.filter((record) => record.status === "active").length,
    review: normalized.filter((record) => record.status === "review").length,
    completion: target === 0 ? 0 : Math.round((logged / target) * 100),
  };
}

export function filterPlacements(records, { query = "", status = "all" } = {}) {
  const needle = query.trim().toLocaleLowerCase("en");
  return records.filter((record) => {
    const statusMatches = status === "all" || record.status === status;
    const textMatches = !needle || [record.student, record.company, record.supervisor]
      .some((value) => value.toLocaleLowerCase("en").includes(needle));
    return statusMatches && textMatches;
  });
}

export function advanceStatus(record) {
  const sequence = ["planned", "active", "review", "complete"];
  const index = sequence.indexOf(record.status);
  if (index === -1) throw new Error(`Unknown status: ${record.status}`);
  return { ...record, status: sequence[Math.min(index + 1, sequence.length - 1)] };
}
