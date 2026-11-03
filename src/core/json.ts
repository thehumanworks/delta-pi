/**
 * Narrowing for JSON this extension did not write (CLI output, saved files): parse it as `unknown`,
 * then check each field before reading it.
 */

/** A JSON object whose fields are not checked yet. */
export type JsonObject = { readonly [key: string]: unknown }

/** An object: not null, not an array. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A string with at least one character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** A finite number. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** An integer within the range a double holds exactly. */
export function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/** One of `allowed`. */
export function isOneOf<const T extends readonly unknown[]>(value: unknown, allowed: T): value is T[number] {
  return allowed.includes(value)
}

/** A value as text: a string as it is, anything else as JSON, or as `String` when JSON cannot say it. */
export function jsonText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
}
