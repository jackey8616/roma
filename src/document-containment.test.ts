import { describe, expect, it } from 'vitest'
import { containment, matching } from '../test/support/sources.js'

/**
 * Google Drive is named under `src/documents/`, and nowhere else — and roma
 * never asks a library to *find* a credential.
 *
 * The third of these, and it is `src/cloud-containment.test.ts` read twice
 * rather than a new idea: the first claim is the containment that keeps the Core
 * seeing a port for obtaining a credential rather than "call Google", which is
 * what lets `wiring.test.ts` assemble roma out of real parts while the free run
 * stays free of anything needing a service account key.
 *
 * The second claim is the one that is not tidiness, and it is why this file
 * exists at all rather than the documents directory being folded into the
 * cloud's rule. Application Default Credentials is a *precedence chain* ending
 * at the metadata server, so on the Google hosts roma is designed for a missing
 * or unreadable key does not fail — it authenticates as the VM's own service
 * account, which is roma's. A missing key must produce a *failure*, never a
 * *substitution*, and ADR-0022 §1 asks for this directory to carry the same rule
 * for the same reason.
 *
 * **Two Google directories, and the duplication between them is deliberate.**
 * The service account key and the JWT-bearer exchange are written twice on
 * ADR-0022's instruction: sharing them would mean a factory able to construct a
 * Google credential in a directory no rule binds, which is exactly what
 * ADR-0020 §7 moved the cloud's construction inside `src/cloud/` to prevent. The
 * cloud's rule therefore leaves this directory alone for the vendor-generic
 * patterns and keeps an unrelaxed list — `cloud-platform`, `gcloud` — that binds
 * it too. The same asymmetry runs the other way here: nothing below is relaxed
 * for `src/cloud/`, because the scope constants are the thing neither directory
 * may take from anywhere but its own.
 */

/**
 * Every way `src/` could name Drive outside `src/documents/`.
 *
 * Deliberately narrow, and deliberately not the words Document Reach, Document
 * Token, Document Shortcut or Depot: those are `CONTEXT.md`'s vocabulary and the
 * Core is *supposed* to use them. What must not leak is the product — the API,
 * the two scopes, the metadata key the tagging convention uses, and the two
 * parameters the boot proof's request turns on.
 */
const DOCUMENTS_SPECIFIC = [
  /googleapis\.com\/drive/i,
  /\bdrive\.file\b/,
  /\bdrive\.readonly\b/,
  /\bappProperties\b/,
  /\bcanAddChildren\b/,
  /\bsupportsAllDrives\b/,
]

/**
 * Every way roma could stop loading the key by the exact path it was given.
 *
 * `src/cloud-containment.test.ts`'s list, unchanged and deliberately not shared:
 * a helper holding it would leave each of these tests a call, and what a
 * containment rule is *for* is the denylist and the reason beside it. All of
 * these are legitimate elsewhere — that is how roma's own credential is resolved
 * for Pub/Sub and Chat, which is a different identity for a different purpose —
 * which is why this binds a directory rather than `src/`.
 */
const RESOLVES_A_CREDENTIAL = [
  /\bGoogleAuth\b/,
  /\bgetApplicationDefault\b/,
  /\bfromEnv\b/,
  /\bGOOGLE_APPLICATION_CREDENTIALS\b/,
  /\bgoogle-auth-library\b/,
]

describe('everything that knows the documents are in Drive lives in one directory', () => {
  it('names it nowhere else', () => {
    const offenders = matching(containment('documents').outside, DOCUMENTS_SPECIFIC)

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  // Without this the test above passes for the wrong reason the day somebody
  // narrows the denylist or breaks the comment stripping: a rule that matches
  // nothing anywhere reports containment it is not checking.
  it('would notice, which is why the directory it excludes trips it', () => {
    const named = matching(containment('documents').inside, DOCUMENTS_SPECIFIC)

    expect(named.length).toBeGreaterThan(0)
  })
})

describe('roma mints from the key it was given, never from a resolution chain', () => {
  // The same claim `src/cloud/` carries, and a test rather than a comment for the
  // same reason: the failure it prevents is silent, arrives by *doing nothing*,
  // and only on production hosts. A Document Reach that resolved would be roma's
  // own identity holding whatever that identity holds in Drive.
  it('has no code under src/documents/ that could ask a library to find a credential', () => {
    const offenders = matching(containment('documents').inside, RESOLVES_A_CREDENTIAL)

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  /**
   * **There is deliberately no source match against the composition root**, for
   * the reason `src/cloud-containment.test.ts` gives: construction lives inside
   * this containment, so the rule above binds it. Adding one would rebuild what
   * ADR-0020 §7 removed; read it first.
   */
})
