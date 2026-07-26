export function parseArgs(
  argv = process.argv.slice(2),
  { strings = [], booleans = [] } = {},
) {
  const stringKeys = new Set(strings);
  const booleanKeys = new Set(booleans);
  const knownKeys = new Set([...stringKeys, ...booleanKeys]);
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (!rawKey) throw new Error("Argument names cannot be empty.");
    if (!knownKeys.has(rawKey)) throw new Error(`Unknown argument: --${rawKey}`);
    if (Object.hasOwn(result, rawKey)) throw new Error(`Duplicate argument: --${rawKey}`);
    if (booleanKeys.has(rawKey)) {
      if (inlineValue !== undefined) {
        throw new Error(`Boolean argument --${rawKey} does not accept a value.`);
      }
      result[rawKey] = true;
      continue;
    }
    if (inlineValue !== undefined) {
      result[rawKey] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[rawKey] = next;
      index += 1;
    } else throw new Error(`--${rawKey} requires a value.`);
  }
  return result;
}

export function requireString(args, key) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`--${key} is required.`);
  }
  return value.trim();
}
