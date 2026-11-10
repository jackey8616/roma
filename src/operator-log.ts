export type OperatorLog<Entry> = (entry: Entry) => void

export function writeToStderr(entry: unknown): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`)
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
