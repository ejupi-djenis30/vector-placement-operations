import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { AppError } from "./errors.mjs";

const CURSOR_VERSION = 2;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function invalidCursor() {
  return new AppError(
    422,
    "invalid_cursor",
    "The pagination cursor is invalid or no longer matches this view.",
  );
}

function canonicalBase64Url(value) {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw invalidCursor();
  return bytes;
}

function bindingFingerprint(binding) {
  return createHash("sha256")
    .update(JSON.stringify(binding))
    .digest("hex");
}

export function createCursorCodec(secret = randomBytes(32)) {
  const secretBytes = Buffer.from(secret);
  if (secretBytes.length < 32) {
    throw new Error("Cursor encryption key must contain at least 32 bytes.");
  }
  const key = createHash("sha256").update(secretBytes).digest();

  return Object.freeze({
    encode(kind, position, binding) {
      const body = Buffer.from(JSON.stringify({
        v: CURSOR_VERSION,
        k: kind,
        b: bindingFingerprint(binding),
        p: position,
      }));
      const nonce = randomBytes(NONCE_BYTES);
      const header = Buffer.concat([Buffer.from([CURSOR_VERSION]), nonce]);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(header);
      const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
      const sealed = Buffer.concat([ciphertext, cipher.getAuthTag()]);
      return `${header.toString("base64url")}.${sealed.toString("base64url")}`;
    },

    decode(encoded, kind, types, binding) {
      if (!encoded) return null;
      try {
        const parts = encoded.split(".");
        if (parts.length !== 2) throw invalidCursor();
        const header = canonicalBase64Url(parts[0]);
        const sealed = canonicalBase64Url(parts[1]);
        if (
          header.length !== NONCE_BYTES + 1
          || header[0] !== CURSOR_VERSION
          || sealed.length <= TAG_BYTES
        ) throw invalidCursor();
        const nonce = header.subarray(1);
        const ciphertext = sealed.subarray(0, -TAG_BYTES);
        const tag = sealed.subarray(-TAG_BYTES);
        const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(header);
        decipher.setAuthTag(tag);
        const body = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        const value = JSON.parse(body.toString("utf8"));
        if (
          value?.v !== CURSOR_VERSION
          || value?.k !== kind
          || value?.b !== bindingFingerprint(binding)
          || !Array.isArray(value.p)
          || value.p.length !== types.length
          || value.p.some((item, index) =>
            typeof item !== types[index]
            || (types[index] === "number" && !Number.isInteger(item))
          )
        ) {
          throw invalidCursor();
        }
        return value.p;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw invalidCursor();
      }
    },
  });
}
