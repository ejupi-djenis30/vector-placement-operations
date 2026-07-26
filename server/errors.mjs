export class AppError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function notFound(entity = "Resource") {
  return new AppError(404, "not_found", `${entity} was not found.`);
}

export function conflict(message) {
  return new AppError(409, "conflict", message);
}
