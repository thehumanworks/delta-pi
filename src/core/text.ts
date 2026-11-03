/** Text helpers: the error message a person reads, and where text can be cut to a budget. */

/** Whether cutting `text` at `index` would split a surrogate pair, leaving half a character behind. */
export function cutsSurrogatePair(text: string, index: number): boolean {
  return /[\uD800-\uDBFF]/.test(text.charAt(index - 1))
}

/** What a person reads for an error: its message, without the class name `String(error)` puts first. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
