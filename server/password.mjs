import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
export const DUMMY_PASSWORD_HASH = "scrypt$16384$8$1$X82FJFFrlqo3gJuSpZ6kwA$5EVbZsnzORaNyn0nB6WVl_MAexcYmuijxmyqLgkybxNjD76-GVW3fIzdG8PQRdk7-MxKAZXaT06er05m0MASRQ";

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < 14 || password.length > 256) {
    throw new Error("Password must contain between 14 and 256 characters.");
  }
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, OPTIONS);
  return [
    "scrypt",
    String(OPTIONS.N),
    String(OPTIONS.r),
    String(OPTIONS.p),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password, encoded) {
  try {
    const [algorithm, rawN, rawR, rawP, rawSalt, rawHash] = encoded.split("$");
    if (algorithm !== "scrypt") return false;
    const N = Number(rawN);
    const r = Number(rawR);
    const p = Number(rawP);
    if (N < 16_384 || N > 131_072 || (N & (N - 1)) !== 0) return false;
    if (!Number.isInteger(r) || r < 8 || r > 32) return false;
    if (!Number.isInteger(p) || p < 1 || p > 8) return false;
    if (typeof password !== "string" || password.length > 256) return false;
    const salt = Buffer.from(rawSalt, "base64url");
    const expected = Buffer.from(rawHash, "base64url");
    if (salt.length < 16 || salt.length > 64 || expected.length !== KEY_LENGTH) return false;
    const options = {
      N,
      r,
      p,
      maxmem: 128 * 1024 * 1024,
    };
    const actual = await scrypt(password, salt, expected.length, options);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
