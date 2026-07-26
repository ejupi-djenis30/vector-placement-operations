import { AppError } from "./errors.mjs";

export function assertIanaTimeZone(value, name = "time zone") {
  const timeZone = String(value);
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    throw new Error(`${name} must be a valid IANA time zone.`);
  }
  return timeZone;
}

export function dateAtInstantInTimeZone(instant, timeZone) {
  assertIanaTimeZone(timeZone);
  const date = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error("The instant is not valid.");
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function currentSchoolDate(db, schoolId, now = new Date()) {
  return schoolDateForInstant(db, schoolId, now);
}

export function schoolDateForInstant(db, schoolId, instant) {
  const row = db.prepare("SELECT time_zone AS timeZone FROM schools WHERE id = ?").get(schoolId);
  if (!row) throw new Error("The school time zone is unavailable.");
  return dateAtInstantInTimeZone(instant, row.timeZone);
}

export function assertNotFutureSchoolDate(db, schoolId, value, now = new Date()) {
  const today = currentSchoolDate(db, schoolId, now);
  if (value > today) {
    throw new AppError(
      422,
      "future_time_entry",
      "Time entries cannot be recorded after the school's current date.",
      { today },
    );
  }
}
