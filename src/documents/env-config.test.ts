import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurationMissing } from '../env-config.js'
import { DOCUMENT_DEPOT_VAR, DOCUMENT_KEY_FILE_VAR, readDocumentEnv } from './env-config.js'

/**
 * What a deployment has to say to have a Document Reach, and what it may leave
 * unsaid.
 *
 * Two asymmetries rather than the cloud reader's one. Absent is not a problem —
 * most deployments have neither variable and are meant to be untouched — but a
 * variable that is *set* and does not work must never quietly become the
 * no-Document-Reach behaviour, because that reads as the feature being broken
 * rather than as a path being wrong. And **half of it is not absence**: a key
 * with no Depot and a Depot with no key are both deployments that meant to have
 * one (ADR-0022 §2).
 *
 * The key file below is written from Google's documentation of a service account
 * key, like every other Drive-facing fixture in this directory: no service
 * account has ever been created for a Document Reach, and nothing here has been
 * measured. Which matters less for this file than for its neighbours — what is
 * asserted here is what roma does with a file's *shape* — but the fixture is the
 * same unverified shape, so it is said here too rather than left to be inferred
 * from the file next door.
 */

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

/** A directory of this test's own, gone when it is over. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'roma-document-env-'))
  dirs.push(dir)
  return dir
}

/** A key file on disk, with whatever is in it. */
function keyFile(contents: string): string {
  const path = join(scratch(), 'key.json')
  writeFileSync(path, contents)
  return path
}

const A_KEY = {
  type: 'service_account',
  project_id: 'a-project',
  private_key_id: 'abc',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot really\n-----END PRIVATE KEY-----\n',
  client_email: 'writer@a-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
}

const DEPOT = 'FOLDER_ID'

describe('a deployment with a Document Reach', () => {
  it('is read out of the key file and the folder it named', () => {
    const path = keyFile(JSON.stringify(A_KEY))

    expect(readDocumentEnv({ [DOCUMENT_KEY_FILE_VAR]: path, [DOCUMENT_DEPOT_VAR]: DEPOT })).toEqual(
      {
        account: 'writer@a-project.iam.gserviceaccount.com',
        privateKey: A_KEY.private_key,
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        depot: DEPOT,
      },
    )
  })

  // The key names where it is exchanged, so roma uses what it was given rather
  // than a constant that would be wrong for anybody Google ever moves.
  it('exchanges where the key says, and has an answer where it does not', () => {
    const named = keyFile(JSON.stringify({ ...A_KEY, token_uri: 'https://elsewhere.test/token' }))
    const { token_uri, ...silent } = A_KEY

    expect(
      readDocumentEnv({ [DOCUMENT_KEY_FILE_VAR]: named, [DOCUMENT_DEPOT_VAR]: DEPOT })
        ?.tokenEndpoint,
    ).toBe('https://elsewhere.test/token')
    expect(
      readDocumentEnv({
        [DOCUMENT_KEY_FILE_VAR]: keyFile(JSON.stringify(silent)),
        [DOCUMENT_DEPOT_VAR]: DEPOT,
      })?.tokenEndpoint,
    ).toBe('https://oauth2.googleapis.com/token')
  })
})

describe('a deployment with none', () => {
  // Story 17: a deployment that wants no Document Reach pays nothing for the
  // feature, and neither variable set is how it says so.
  it('is not a problem, and is not one when the variables are empty either', () => {
    expect(readDocumentEnv({})).toBeNull()
    // What a shell leaves behind when a variable was set from something that
    // turned out to be empty. `envValue`'s rule for every optional variable roma
    // has, and departing from it here would refuse to boot a deployment that
    // deliberately blanked both to turn the feature off.
    expect(readDocumentEnv({ [DOCUMENT_KEY_FILE_VAR]: '', [DOCUMENT_DEPOT_VAR]: '' })).toBeNull()
  })
})

/**
 * Story 25: half a Document Reach is a deployment that meant to have one.
 *
 * A key with no Depot is a credential with nowhere to write; a Depot with no key
 * is a folder nobody can reach. Falling through to null for either would mean a
 * deployment that set one variable gets the no-Document-Reach behaviour, and
 * finds out from an agent saying it has no way to write a document.
 */
describe('a Document Reach configured halfway', () => {
  it('refuses a key with no Depot, naming the variable that is missing', () => {
    const path = keyFile(JSON.stringify(A_KEY))

    expect(() => readDocumentEnv({ [DOCUMENT_KEY_FILE_VAR]: path })).toThrow(ConfigurationMissing)
    expect(() => readDocumentEnv({ [DOCUMENT_KEY_FILE_VAR]: path })).toThrow(DOCUMENT_DEPOT_VAR)
  })

  it('refuses a Depot with no key, naming the variable that is missing', () => {
    expect(() => readDocumentEnv({ [DOCUMENT_DEPOT_VAR]: DEPOT })).toThrow(ConfigurationMissing)
    expect(() => readDocumentEnv({ [DOCUMENT_DEPOT_VAR]: DEPOT })).toThrow(DOCUMENT_KEY_FILE_VAR)
  })

  // Story 26, and the reason both halves are read synchronously: every problem
  // this reader can find lands in `readConfiguration`'s single refusal, so
  // fixing an environment takes one boot rather than several. Asserted as the
  // type rather than the message, because that type is what `attempted`
  // collects — anything else would be a reader that is broken rather than an
  // environment that is.
  it('refuses in the shape every other configuration problem arrives in', () => {
    try {
      readDocumentEnv({ [DOCUMENT_DEPOT_VAR]: DEPOT })
      expect.unreachable('should have refused')
    } catch (error) {
      expect((error as ConfigurationMissing).problems).toHaveLength(1)
    }
  })
})

describe('a Document Reach that was meant and does not work', () => {
  // Every one of these must refuse rather than resolve to null. Falling through
  // to "no Document Reach" would mean a mistyped path presents as the capability
  // being absent, which is a diagnosis nobody can act on — and on a Google host
  // it is one step from the failure ADR-0015 §4 exists to prevent.
  it.each([
    ['a path that is not there', () => join(scratch(), 'gone.json'), /could not read/],
    ['a file with nothing in it', () => keyFile('   \n'), /empty/],
    ['a file that is not JSON', () => keyFile('-----BEGIN PRIVATE KEY-----\n'), /not JSON/],
    [
      'JSON that is not a service account key',
      () => keyFile('{"hello":"world"}'),
      /not a service account key/,
    ],
    [
      'a key with no private half',
      () => keyFile(JSON.stringify({ ...A_KEY, private_key: '' })),
      /not a service account key/,
    ],
  ])('refuses %s', (_what, named, complaint) => {
    const env = { [DOCUMENT_KEY_FILE_VAR]: named(), [DOCUMENT_DEPOT_VAR]: DEPOT }

    expect(() => readDocumentEnv(env)).toThrow(ConfigurationMissing)
    expect(() => readDocumentEnv(env)).toThrow(complaint)
  })

  // Named in every refusal, because the commonest of these is a path that is
  // wrong and the fix is to look at what roma was actually given.
  it('says which path it was given', () => {
    const named = keyFile('not json at all')

    expect(() =>
      readDocumentEnv({ [DOCUMENT_KEY_FILE_VAR]: named, [DOCUMENT_DEPOT_VAR]: DEPOT }),
    ).toThrow(named)
  })

  // The Depot is not checked here and cannot be: whether that folder exists and
  // whether this identity may add to it is a network round trip, and this reader
  // is the synchronous half. That is the boot proof's job (ADR-0022 §6).
  it('takes the Depot as given, since only the boot proof can check one', () => {
    const path = keyFile(JSON.stringify(A_KEY))

    expect(
      readDocumentEnv({ [DOCUMENT_KEY_FILE_VAR]: path, [DOCUMENT_DEPOT_VAR]: 'not-a-folder-id' })
        ?.depot,
    ).toBe('not-a-folder-id')
  })
})
