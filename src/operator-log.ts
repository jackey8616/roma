/**
 * The Operator Log. A plain function, so a test can hand in an array's `push`.
 */
export type OperatorLog<Entry> = (entry: Entry) => void

/** The default everywhere: one JSON object per line on stderr. */
export function writeToStderr(entry: unknown): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`)
}

/** What went wrong, as a line an operator can read. Use this rather than a private copy. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
