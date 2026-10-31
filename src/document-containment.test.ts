import { describe, expect, it } from 'vitest'
import { containment, matching } from '../test/support/sources.js'

const DOCUMENTS_SPECIFIC = [
  /googleapis\.com\/drive/i,
  /\bdrive\.file\b/,
  /\bdrive\.readonly\b/,
  /\bappProperties\b/,
  /\bcanAddChildren\b/,
  /\bsupportsAllDrives\b/,
]

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

  it('would notice, which is why the directory it excludes trips it', () => {
    const named = matching(containment('documents').inside, DOCUMENTS_SPECIFIC)

    expect(named.length).toBeGreaterThan(0)
  })
})

describe('roma mints from the key it was given, never from a resolution chain', () => {
  it('has no code under src/documents/ that could ask a library to find a credential [fence:documents-never-resolves-a-credential]', () => {
    const offenders = matching(containment('documents').inside, RESOLVES_A_CREDENTIAL)

    expect(
      offenders.map(({ file }) => file),
      'Nothing under src/documents/ may ask a library to find a credential: the key is read ' +
        'by the exact path the deployment named and signed here (ADR-0022 §1, ADR-0015 §4). ' +
        'Application Default Credentials ends at the metadata server, so on the Google hosts ' +
        "roma runs on a missing key resolves to roma's own identity, holding whatever that " +
        'identity holds in Drive (#132).',
    ).toEqual([])
  })

  it('shares no exchange with src/cloud/, in either direction [fence:documents-shares-no-exchange-with-the-cloud]', () => {
    const fromCloud = matching(containment('documents').inside, [/from '\.\.\/cloud\//])
    const fromDocuments = matching(containment('cloud').inside, [/from '\.\.\/documents\//])

    expect(
      [...fromCloud, ...fromDocuments].map(({ file }) => file),
      'src/documents/ and src/cloud/ each sign their own JWT-bearer exchange and import ' +
        'nothing from each other (ADR-0022, ADR-0020 §7). Neither may take its scope or its ' +
        'construction from anywhere but itself, and a shared factory outside both is a way to ' +
        'construct a Google credential in a directory no containment rule binds (#132).',
    ).toEqual([])
  })
})
