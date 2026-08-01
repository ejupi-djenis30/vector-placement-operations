import { AppError } from "./errors.mjs";

const COLLECTIONS = Object.freeze({
  timeEntries: Object.freeze({
    label: "time entries",
    limit: 500,
    capacitySql: `
      SELECT COUNT(*) AS count
      FROM (
        SELECT 1
        FROM time_entries
        WHERE placement_id = ?
        LIMIT ?
      )
    `,
  }),
  checkIns: Object.freeze({
    label: "check-ins",
    limit: 200,
    capacitySql: `
      SELECT COUNT(*) AS count
      FROM (
        SELECT 1
        FROM check_ins
        WHERE placement_id = ?
        LIMIT ?
      )
    `,
  }),
  documents: Object.freeze({
    label: "documents",
    limit: 200,
    capacitySql: `
      SELECT COUNT(*) AS count
      FROM (
        SELECT 1
        FROM placement_documents
        WHERE placement_id = ?
        LIMIT ?
      )
    `,
  }),
});

export const PLACEMENT_CHILD_LIMITS = Object.freeze(
  Object.fromEntries(
    Object.entries(COLLECTIONS).map(([name, configuration]) => [
      name,
      configuration.limit,
    ]),
  ),
);

function configurationFor(collection) {
  const configuration = COLLECTIONS[collection];
  if (!configuration) throw new TypeError(`Unknown placement activity collection: ${collection}`);
  return configuration;
}

function capacityError(collection, configuration) {
  return new AppError(
    409,
    "placement_activity_capacity_reached",
    `This placement cannot contain more than ${configuration.limit} ${configuration.label}. Preserve the record and create a continuation placement before adding more.`,
    { collection, maximum: configuration.limit },
  );
}

function exceededError(collection, configuration) {
  return new AppError(
    409,
    "placement_activity_capacity_exceeded",
    `This placement exceeds the supported ${configuration.label} capacity. An administrator must repair the record before it can be opened.`,
    {
      collection,
      maximum: configuration.limit,
      minimumObserved: configuration.limit + 1,
    },
  );
}

function boundedCount(db, collection, placementId, probeLimit) {
  const configuration = configurationFor(collection);
  return {
    configuration,
    count: db.prepare(configuration.capacitySql).get(placementId, probeLimit).count,
  };
}

export function assertPlacementChildCapacity(
  db,
  collection,
  placementId,
  additions = 1,
) {
  const configuration = configurationFor(collection);
  if (!Number.isSafeInteger(additions) || additions < 1) {
    throw new TypeError("Placement activity additions must be a positive integer.");
  }
  if (additions > configuration.limit) throw capacityError(collection, configuration);
  const probeLimit = configuration.limit - additions + 1;
  const { count } = boundedCount(db, collection, placementId, probeLimit);
  if (count >= probeLimit) throw capacityError(collection, configuration);
}

export function assertPlacementChildrenWithinCapacity(db, placementId) {
  for (const collection of Object.keys(COLLECTIONS)) {
    const configuration = configurationFor(collection);
    const { count } = boundedCount(
      db,
      collection,
      placementId,
      configuration.limit + 1,
    );
    if (count > configuration.limit) throw exceededError(collection, configuration);
  }
}

export function boundedPlacementChildRows(rows, collection) {
  const configuration = configurationFor(collection);
  if (rows.length > configuration.limit) throw exceededError(collection, configuration);
  return rows;
}
