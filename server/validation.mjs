import { AppError } from "./errors.mjs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isIsoDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function assertDateRange(startDate, endDate) {
  if (!isIsoDate(startDate) || !isIsoDate(endDate) || endDate < startDate) {
    throw new AppError(
      422,
      "invalid_date_range",
      "Dates must be valid ISO dates and the end date must not precede the start date.",
    );
  }
}

export function hoursToMinutes(hours) {
  const value = Number(hours);
  const minutes = Math.round(value * 60);
  if (!Number.isFinite(value) || value <= 0 || minutes > 120_000) {
    throw new AppError(422, "invalid_hours", "Hours must be greater than zero.");
  }
  if (Math.abs(value * 60 - minutes) > 0.000001) {
    throw new AppError(422, "invalid_hours", "Hours must resolve to whole minutes.");
  }
  return minutes;
}

export function minutesToHours(minutes) {
  return Number((minutes / 60).toFixed(2));
}

export function assertTargetMinutesFeasible(startDate, endDate, targetMinutes) {
  assertDateRange(startDate, endDate);
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  const inclusiveDays = Math.floor((end - start) / 86_400_000) + 1;
  if (
    !Number.isSafeInteger(targetMinutes)
    || targetMinutes <= 0
    || targetMinutes > inclusiveDays * 24 * 60
  ) {
    throw new AppError(
      422,
      "target_hours_impossible",
      "Target hours cannot exceed 24 hours for each placement day.",
    );
  }
  return inclusiveDays;
}

export function assertHexColor(value) {
  if (!HEX_COLOR.test(value)) {
    throw new AppError(422, "invalid_color", "Colours must use six-digit hexadecimal notation.");
  }
  return value.toLowerCase();
}

function rgbChannel(hex, offset) {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const color = assertHexColor(hex);
  return 0.2126 * rgbChannel(color, 1)
    + 0.7152 * rgbChannel(color, 3)
    + 0.0722 * rgbChannel(color, 5);
}

export function contrastRatio(first, second) {
  const high = Math.max(relativeLuminance(first), relativeLuminance(second));
  const low = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (high + 0.05) / (low + 0.05);
}

export function readableTextColor(background) {
  const blackContrast = contrastRatio(background, "#000000");
  const whiteContrast = contrastRatio(background, "#ffffff");
  const chosen = blackContrast >= whiteContrast ? "#000000" : "#ffffff";
  if (Math.max(blackContrast, whiteContrast) < 4.5) {
    throw new AppError(422, "insufficient_contrast", "The selected colour cannot support readable text.");
  }
  return chosen;
}

export function assertBrandPalette({ primaryColor, accentColor, surfaceColor }) {
  const primary = assertHexColor(primaryColor);
  const accent = assertHexColor(accentColor);
  const surface = assertHexColor(surfaceColor);
  if (contrastRatio(primary, surface) < 4.5) {
    throw new AppError(
      422,
      "insufficient_contrast",
      "Primary and surface colours must have a contrast ratio of at least 4.5:1.",
    );
  }
  return {
    primaryColor: primary,
    accentColor: accent,
    surfaceColor: surface,
    onPrimaryColor: readableTextColor(primary),
    onAccentColor: readableTextColor(accent),
    onSurfaceColor: readableTextColor(surface),
  };
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function pngCrc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = PNG_CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function assertPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 57 || buffer.length > 262_144) {
    throw new AppError(422, "invalid_logo", "The logo must be a PNG file no larger than 256 KB.");
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new AppError(422, "invalid_logo", "The uploaded file is not a valid PNG image.");
  }

  let offset = 8;
  let chunkIndex = 0;
  let width = 0;
  let height = 0;
  let hasImageData = false;
  let hasEnd = false;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      throw new AppError(422, "invalid_logo", "The PNG chunk structure is incomplete.");
    }
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > buffer.length) {
      throw new AppError(422, "invalid_logo", "The PNG chunk length is invalid.");
    }
    const type = buffer.toString("ascii", typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new AppError(422, "invalid_logo", "The PNG contains an invalid chunk type.");
    }
    if (pngCrc32(buffer.subarray(typeStart, dataEnd)) !== buffer.readUInt32BE(dataEnd)) {
      throw new AppError(422, "invalid_logo", "The PNG failed its integrity check.");
    }
    if (chunkIndex === 0 && type !== "IHDR") {
      throw new AppError(422, "invalid_logo", "The PNG header chunk must come first.");
    }

    if (type === "IHDR") {
      if (chunkIndex !== 0 || length !== 13) {
        throw new AppError(422, "invalid_logo", "The PNG header is malformed.");
      }
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      const compression = buffer[dataStart + 10];
      const filter = buffer[dataStart + 11];
      const interlace = buffer[dataStart + 12];
      if (compression !== 0 || filter !== 0 || interlace > 1) {
        throw new AppError(422, "invalid_logo", "The PNG uses unsupported header settings.");
      }
    } else if (type === "IDAT") {
      if (hasEnd) throw new AppError(422, "invalid_logo", "The PNG image data is misplaced.");
      hasImageData = true;
    } else if (type === "IEND") {
      if (length !== 0 || hasEnd || chunkEnd !== buffer.length) {
        throw new AppError(422, "invalid_logo", "The PNG end chunk is malformed.");
      }
      hasEnd = true;
    } else if (type[0] === type[0].toUpperCase() && type !== "PLTE") {
      throw new AppError(422, "invalid_logo", "The PNG contains an unsupported critical chunk.");
    }

    offset = chunkEnd;
    chunkIndex += 1;
  }
  if (!hasImageData || !hasEnd) {
    throw new AppError(422, "invalid_logo", "The PNG is missing required image chunks.");
  }
  if (width < 16 || height < 16 || width > 2048 || height > 2048) {
    throw new AppError(
      422,
      "invalid_logo_dimensions",
      "Logo dimensions must be between 16 and 2048 pixels.",
    );
  }
  return { width, height };
}

export function cleanText(value, maxLength, { required = false } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new AppError(422, "required_field", "A required field is empty.");
  if (text.length > maxLength) {
    throw new AppError(422, "field_too_long", `Text must not exceed ${maxLength} characters.`);
  }
  return text;
}
