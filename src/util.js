export function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function arrayValue(value) {
  return Array.isArray(value) ? value : null;
}
