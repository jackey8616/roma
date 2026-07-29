/**
 * Where roma writes down what it did, for whoever is running it.
 *
 * Distinct from the Audit Record in both audience and lifetime: an Audit Record
 * answers "who spent what" months later and is kept, while this is the running
 * commentary an operator reads when something looks wrong — an eviction, a
 * credential swap, a refusal. Nothing here is money; the money is in the records.
 *
 * A function rather than a logger, so that a caller can hand in an array in a
 * test and nothing has to be configured to keep a test quiet.
 */
export type OperatorLog<Record> = (record: Record) => void

/**
 * The default everywhere: one JSON object per line on stderr.
 *
 * One line per record, because that is what a log shipper can read back without
 * being taught anything about roma.
 */
export function writeToStderr(record: unknown): void {
  process.stderr.write(`${JSON.stringify(record)}\n`)
}
