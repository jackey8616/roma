import { describe, expect, it } from 'vitest'
import { code, containment } from '../test/support/sources.js'

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
 * Every way `src/` could name the agent's cloud outside the one directory.
 *
 * Deliberately narrow, and deliberately not the bare word "cloud": Cloud Reach,
 * Cloud Token and Cloud Shortcut are `CONTEXT.md`'s vocabulary and the Core is
 * *supposed* to use them. What must not leak is the provider — the endpoint, the
 * scope, the shape of the key, the CLI that is not installed.
 */
const CLOUD_SPECIFIC = [
  /oauth2\.googleapis/i,
  /\bcloud-platform\b/,
  /\bservice_account\b/,
  /\bclient_email\b/,
  /\bgcloud\b/,
  /jwt-bearer/i,
]

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
  it('names it nowhere else', () => {
    const offenders = containment('cloud').outside.filter(({ source }) =>
      CLOUD_SPECIFIC.some((pattern) => pattern.test(code(source))),
    )

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  // Without this the test above passes for the wrong reason the day somebody
  // narrows the denylist or breaks the comment stripping: a rule that matches
  // nothing anywhere reports containment it is not checking.
  it('would notice, which is why the directory it excludes trips it', () => {
    const named = containment('cloud').inside.filter(({ source }) =>
      CLOUD_SPECIFIC.some((pattern) => pattern.test(code(source))),
    )

    expect(named.length).toBeGreaterThan(0)
  })
})

describe('roma mints from the key it was given, never from a resolution chain', () => {
  // The whole of §4, and the reason it is a test rather than a comment: the
  // failure it prevents is silent, arrives by *doing nothing*, and only on
  // production hosts.
  it('has no code under src/cloud/ that could ask a library to find a credential', () => {
    const offenders = containment('cloud').inside.filter(({ source }) =>
      RESOLVES_A_CREDENTIAL.some((pattern) => pattern.test(code(source))),
    )

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  /**
   * **The source match that used to live here is deleted (ADR-0020 §7).**
   *
   * It asserted that the composition root contained `new
   * GoogleCloudMinter(cloudEnv)` — because that file is the one place the
   * substitution §4 forbids could be written, and the rule above deliberately
   * does not bind it: it holds a live `GoogleAuth` on purpose, which is how roma
   * resolves its *own* credential for Pub/Sub and Chat.
   *
   * The construction moved into `src/cloud/reach.ts`, behind `cloudReachFrom(env:
   * CloudEnv | null)`. That file is *inside* this containment, so the rule above
   * now binds the construction site for the first time — and the composition root
   * no longer names the constructor, so there is nothing there to substitute.
   * What is left for a caller to get wrong is passing something other than
   * `readCloudEnv`'s output, and anything of that shape is a private key somebody
   * already holds rather than the resolution chain §4 is about.
   *
   * Do not add a source match back without reading ADR-0020 §7. What went with it
   * is the only rule aimed at the composition root at all, which the ADR records
   * as accepted rather than overlooked.
   */
})
