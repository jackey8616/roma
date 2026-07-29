/**
 * Where roma writes down what it did, for whoever is running it.
 *
 * Distinct from the Audit Record in both audience and lifetime: an Audit Record
 * answers "who spent what" months later and is kept, while this is the running
 * commentary an operator reads when something looks wrong — an eviction, a
 * credential swap, a refusal. Where a figure appears here it is there to explain
 * a decision roma made, and the Audit Records remain the account of the money
 * itself; nothing is totalled from this.
 *
 * A function rather than a logger, so that a caller can hand in an array in a
 * test and nothing has to be configured to keep a test quiet.
 */
export type OperatorLog<Entry> = (entry: Entry) => void

/**
 * The default everywhere: one JSON object per line on stderr.
 *
 * One line per record, because that is what a log shipper can read back without
 * being taught anything about roma.
 */
export function writeToStderr(entry: unknown): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`)
}
