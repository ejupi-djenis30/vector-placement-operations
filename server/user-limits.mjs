import { AppError } from "./errors.mjs";

export const MAX_USERS_PER_SCHOOL = 500;

function limitReached() {
  return new AppError(
    422,
    "user_limit_reached",
    `A school can retain at most ${MAX_USERS_PER_SCHOOL} user accounts.`,
    { maximum: MAX_USERS_PER_SCHOOL },
  );
}

export function assertUserCapacity(db, schoolId) {
  const atLimit = db.prepare(`
    SELECT 1
    FROM users
    WHERE school_id = ?
    LIMIT 1 OFFSET ?
  `).get(schoolId, MAX_USERS_PER_SCHOOL - 1);
  if (atLimit) throw limitReached();
}

export function assertSupportedUserCollection(rows) {
  if (rows.length <= MAX_USERS_PER_SCHOOL) return rows;
  throw new AppError(
    422,
    "user_capacity_exceeded",
    `This installation contains more than the supported ${MAX_USERS_PER_SCHOOL} user accounts.`,
    {
      maximum: MAX_USERS_PER_SCHOOL,
      minimumObserved: MAX_USERS_PER_SCHOOL + 1,
    },
  );
}

export function translateUserCapacityConstraint(error) {
  if (/user capacity reached/i.test(String(error?.message ?? ""))) {
    throw limitReached();
  }
  throw error;
}
