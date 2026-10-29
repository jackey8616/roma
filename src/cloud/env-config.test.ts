import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurationMissing } from '../env-config.js'
import { CLOUD_KEY_FILE_VAR, readCloudEnv } from './env-config.js'

/**
 * What a deployment has to say to have a Cloud Reach, and what it may leave
 * unsaid.
 *
 * The asymmetry is the whole of this file. Absent is not a problem — most
 * deployments have no Cloud Reach and are meant to be untouched (ADR-0015 §9) —
 * but a variable that is *set* and does not work must never quietly become the
 * no-Cloud-Reach behaviour, because that reads as the feature being broken
 * rather than as a path being wrong.
 */

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

/** A directory of this test's own, gone when it is over. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'roma-cloud-env-'))
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
  client_email: 'agent@a-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
}

describe('a deployment with a Cloud Reach', () => {
  it('is read out of the key file it named', () => {
    const path = keyFile(JSON.stringify(A_KEY))

    expect(readCloudEnv({ [CLOUD_KEY_FILE_VAR]: path })).toEqual({
      account: 'agent@a-project.iam.gserviceaccount.com',
      privateKey: A_KEY.private_key,
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
    })
  })

  // The key names where it is exchanged, so roma uses what it was given rather
  // than a constant that would be wrong for anybody Google ever moves.
  it('exchanges where the key says, and has an answer where it does not [fence:cloud-exchanges-where-the-key-says]', () => {
    const why =
      "The token endpoint is the key file's own `token_uri`, defaulted only where the key " +
      'omits it (ADR-0015 §3). A hardcoded constant silently ignores a key that says ' +
      'otherwise, and the mint fails for any deployment Google moves or any non-public ' +
      'endpoint. It is no widening: whoever can write the file can replace the whole key (#99).'
    const named = keyFile(JSON.stringify({ ...A_KEY, token_uri: 'https://elsewhere.test/token' }))
    const { token_uri, ...silent } = A_KEY

    expect(readCloudEnv({ [CLOUD_KEY_FILE_VAR]: named })?.tokenEndpoint, why).toBe(
      'https://elsewhere.test/token',
    )
    expect(
      readCloudEnv({ [CLOUD_KEY_FILE_VAR]: keyFile(JSON.stringify(silent)) })?.tokenEndpoint,
      why,
    ).toBe('https://oauth2.googleapis.com/token')
  })
})

describe('a deployment with none', () => {
  // Story 17: a deployment with no Google Cloud pays nothing for the feature.
  it('is not a problem, and is not one when the variable is empty either [fence:cloud-refuses-only-a-named-path]', () => {
    const why =
      'No path, or an empty one, is no Cloud Reach and boots (ADR-0015 §9). The empty string ' +
      "is what a shell leaves for `ROMA_CLOUD_KEY_FILE=${UNSET}`, and `envValue`'s rule for " +
      'every optional variable; refusing it refuses to boot a deployment that blanked the ' +
      'variable to turn the feature off. The Operator Log says at every boot whether there ' +
      'is a Cloud Reach (#99).'
    expect(readCloudEnv({}), why).toBeNull()
    // What a shell leaves behind when a variable was set from something that
    // turned out to be empty.
    expect(readCloudEnv({ [CLOUD_KEY_FILE_VAR]: '' }), why).toBeNull()
  })
})

describe('a Cloud Reach that was meant and does not work [fence:cloud-refuses-only-a-named-path]', () => {
  const WHY =
    'A path that was named and does not work refuses the boot, and never reads as no Cloud ' +
    'Reach (ADR-0015 §9). A mistyped path that fell through would present as the ' +
    'capability being absent, a diagnosis nobody can act on — and on a Google host it is one ' +
    "step from resolving roma's own identity (ADR-0015 §4) (#99)."

  // Every one of these must refuse rather than resolve to null. Falling through
  // to "no Cloud Reach" would mean a mistyped path presents as the capability
  // being absent, which is a diagnosis nobody can act on — and on a Google host
  // it is one step from the failure §4 exists to prevent.
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
    const path = named()

    expect(() => readCloudEnv({ [CLOUD_KEY_FILE_VAR]: path }), WHY).toThrow(ConfigurationMissing)
    expect(() => readCloudEnv({ [CLOUD_KEY_FILE_VAR]: path }), WHY).toThrow(complaint)
  })

  // Named in every refusal, because the commonest of these is a path that is
  // wrong and the fix is to look at what roma was actually given.
  it('says which path it was given', () => {
    const named = keyFile('not json at all')

    expect(() => readCloudEnv({ [CLOUD_KEY_FILE_VAR]: named })).toThrow(named)
  })
})
