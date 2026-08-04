import { describe, expect, it } from 'vitest'
import { containment, matching } from '../test/support/sources.js'

/**
 * Google Cloud is named under `src/cloud/`, and nowhere else — and roma never
 * asks a library to *find* a credential.
 *
 * Two claims in one file because they are the same claim from two sides. The
 * first is the containment `src/github-containment.test.ts` keeps for the other
 * provider: the Core sees a port for obtaining a credential and never "call
 * Google", which is what lets `wiring.test.ts` assemble roma out of real parts
 * while the free run stays free of anything that needs a service account key.
 *
 * The second is the one that is not tidiness. Application Default Credentials is
 * a *precedence chain* ending at the metadata server, so on the Google hosts
 * roma is designed for a missing or unreadable key does not fail — it
 * authenticates as the VM's own service account, which is roma's, holding
 * `pubsub.subscriber` on roma's own ingress. That is the one identity a Cloud
 * Reach must never be (ADR-0015 §2), and nobody configures it: it happens by
 * doing nothing at all, on exactly the hosts roma is built for and on no
 * developer machine. A missing key must produce a *failure*, never a
 * *substitution*.
 *
 * Written in the idiom `src/channels/google-chat/provisioning.test.ts` uses —
 * read the sources and fail on a denylist — because both are the kind of claim
 * that stays green while it stops being true.
 */

/**
 * Every way `src/` could name Google outside a directory some rule binds.
 *
 * Deliberately narrow, and deliberately not the bare word "cloud": Cloud Reach,
 * Cloud Token and Cloud Shortcut are `CONTEXT.md`'s vocabulary and the Core is
 * *supposed* to use them. What must not leak is the provider — the endpoint, the
 * shape of the key, the grant the exchange takes.
 *
 * **Two lists rather than one, since there is a second Google directory.**
 * `src/documents/` reads a service account key and signs a JWT-bearer assertion
 * exactly as this one does, duplicated on ADR-0022's instruction — sharing the
 * exchange would put a factory for Google credentials in a directory no rule
 * binds, which is what ADR-0020 §7 moved the cloud's construction *inside* this
 * one to prevent. So these patterns are bound to "a directory a containment rule
 * binds" and the list below is bound to this one alone.
 */
const GOOGLE_SPECIFIC = [
  /oauth2\.googleapis/i,
  /\bservice_account\b/,
  /\bclient_email\b/,
  /jwt-bearer/i,
]

/**
 * Every way `src/` could name *this* cloud, including from the other Google
 * directory.
 *
 * Unrelaxed, and that is the point of splitting the list: ADR-0022 says neither
 * Google directory may take its scope from anywhere but its own constant, so
 * `cloud-platform` appearing under `src/documents/` would be that rule broken
 * rather than knowledge legitimately shared. `gcloud` is the CLI ADR-0015 §1
 * refuses to ship, and it belongs to the same one directory.
 */
const CLOUD_SPECIFIC = [/\bcloud-platform\b/, /\bgcloud\b/]

/**
 * The other directory a containment rule already binds —
 * `src/document-containment.test.ts`. Named for what it is to *this* rule rather
 * than for what is in it: an exemption from the list above, and from nothing else.
 */
const BOUND_BY_ANOTHER_RULE = ['documents']

/**
 * Every way roma could stop loading the key by the exact path it was given.
 *
 * The library's own names for asking it to go and find one. `GoogleAuth` is the
 * class, `getApplicationDefault` and `fromEnv` are the calls, and
 * `GOOGLE_APPLICATION_CREDENTIALS` is the variable that chain reads — and note
 * that all of them are legitimate *elsewhere*: that is how roma's own credential
 * is resolved for Pub/Sub and Chat, which is a different identity for a
 * different purpose. That is why this rule binds `src/cloud/` rather than `src/`,
 * and why the composition root — where both identities are in scope at once —
 * gets a rule of its own below.
 */
const RESOLVES_A_CREDENTIAL = [
  /\bGoogleAuth\b/,
  /\bgetApplicationDefault\b/,
  /\bfromEnv\b/,
  /\bGOOGLE_APPLICATION_CREDENTIALS\b/,
  /\bgoogle-auth-library\b/,
]

describe('everything that knows which cloud this is lives in one directory', () => {
  // The vendor-generic half, which `src/documents/` may legitimately name too —
  // it holds the second service account key and the second JWT-bearer exchange,
  // and it is bound by a rule of its own.
  it('names Google nowhere a rule does not bind', () => {
    const offenders = matching(containment('cloud', BOUND_BY_ANOTHER_RULE).outside, GOOGLE_SPECIFIC)

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  // Not relaxed for the other Google directory, deliberately: a scope is the one
  // thing neither of them may take from anywhere but its own constant, and the
  // CLI ADR-0015 refuses to ship is this directory's business alone.
  it('names this cloud nowhere else at all, the documents directory included', () => {
    const offenders = matching(containment('cloud').outside, CLOUD_SPECIFIC)

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  // Without this the tests above pass for the wrong reason the day somebody
  // narrows a denylist or breaks the comment stripping: a rule that matches
  // nothing anywhere reports containment it is not checking.
  it('would notice, which is why the directory it excludes trips it', () => {
    const named = matching(containment('cloud').inside, [...GOOGLE_SPECIFIC, ...CLOUD_SPECIFIC])

    expect(named.length).toBeGreaterThan(0)
  })
})

describe('roma mints from the key it was given, never from a resolution chain', () => {
  // The whole of §4, and the reason it is a test rather than a comment: the
  // failure it prevents is silent, arrives by *doing nothing*, and only on
  // production hosts.
  it('has no code under src/cloud/ that could ask a library to find a credential', () => {
    const offenders = matching(containment('cloud').inside, RESOLVES_A_CREDENTIAL)

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  /**
   * **Nothing here binds the composition root, and that is deliberate.**
   *
   * Construction moved inside this containment (`cloudReachFrom`), so the rule
   * above binds the construction site and the root no longer names the
   * constructor. Do not add a source match back without reading ADR-0020 §7 —
   * what went with it is the only rule that ever aimed at the composition root,
   * which the ADR records as accepted rather than overlooked.
   */
})
