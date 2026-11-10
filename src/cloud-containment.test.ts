import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { containment, matching, sources } from '../test/support/sources.js'

const GOOGLE_SPECIFIC = [
  /oauth2\.googleapis/i,
  /\bservice_account\b/,
  /\bclient_email\b/,
  /jwt-bearer/i,
]

const CLOUD_SPECIFIC = [/\bcloud-platform\b/, /\bgcloud\b/]

const BOUND_BY_ANOTHER_RULE = ['documents']

const RESOLVES_A_CREDENTIAL = [
  /\bGoogleAuth\b/,
  /\bgetApplicationDefault\b/,
  /\bfromEnv\b/,
  /\bGOOGLE_APPLICATION_CREDENTIALS\b/,
  /\bgoogle-auth-library\b/,
]

describe('everything that knows which cloud this is lives in one directory', () => {
  it('names Google nowhere a rule does not bind [fence:cloud-google-named-only-where-bound]', () => {
    const offenders = matching(containment('cloud', BOUND_BY_ANOTHER_RULE).outside, GOOGLE_SPECIFIC)

    expect(
      offenders.map(({ file }) => file),
      'Google is named only under src/cloud/ and src/documents/, each bound by its own ' +
        'containment rule (ADR-0020 §7, ADR-0022). A shared token-exchange factory anywhere ' +
        'else would construct a Google credential in a directory no rule binds, where the ' +
        'resolution-chain denylist cannot see it (#119, #132).',
    ).toEqual([])
  })

  it('names this cloud nowhere else at all, the documents directory included', () => {
    const offenders = matching(containment('cloud').outside, CLOUD_SPECIFIC)

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  it('would notice, which is why the directory it excludes trips it', () => {
    const named = matching(containment('cloud').inside, [...GOOGLE_SPECIFIC, ...CLOUD_SPECIFIC])

    expect(named.length).toBeGreaterThan(0)
  })
})

describe('roma mints from the key it was given, never from a resolution chain', () => {
  it('has no code under src/cloud/ that could ask a library to find a credential [fence:cloud-never-resolves-a-credential]', () => {
    const offenders = matching(containment('cloud').inside, RESOLVES_A_CREDENTIAL)

    expect(
      offenders.map(({ file }) => file),
      'Nothing under src/cloud/ may ask a library to find a credential: the key is read by ' +
        'the exact path the deployment named and signed here (ADR-0015 §4). Application ' +
        'Default Credentials ends at the metadata server, so on the Google hosts roma runs on ' +
        "a missing key resolves to roma's own identity — the one a Cloud Reach must never be. " +
        'Handing the library a key explicitly works today and leaves that path one edit away (#99).',
    ).toEqual([])
  })

  it('resolves a credential by chain only where roma names its own identity [fence:chain-only-for-romas-own-identity]', () => {
    const offenders = matching(
      sources().filter(({ file }) => !file.split(sep).includes('google-chat')),
      RESOLVES_A_CREDENTIAL,
    )

    expect(
      offenders.map(({ file }) => file),
      'A credential resolution chain may be named only under src/channels/google-chat/, where ' +
        'roma resolves its own identity for Chat (ADR-0020 §7, ADR-0015 §4). Anywhere else — ' +
        'the composition roots included — it is one edit from building a Reach on roma’s own ' +
        'service account, which on Google hosts succeeds silently.',
    ).toEqual([])
  })
})
