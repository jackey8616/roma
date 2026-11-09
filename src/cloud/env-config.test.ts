import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurationMissing } from '../env-config.js'
import { CLOUD_KEY_FILE_VAR, readCloudEnv } from './env-config.js'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'roma-cloud-env-'))
  dirs.push(dir)
  return dir
}

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
  it('is not a problem, and is not one when the variable is empty either [fence:cloud-refuses-only-a-named-path]', () => {
    const why =
      'No path, or an empty one, is no Cloud Reach and boots (ADR-0015 §9). The empty string ' +
      "is what a shell leaves for `ROMA_CLOUD_KEY_FILE=${UNSET}`, and `envValue`'s rule for " +
      'every optional variable; refusing it refuses to boot a deployment that blanked the ' +
      'variable to turn the feature off. The Operator Log says at every boot whether there ' +
      'is a Cloud Reach (#99).'
    expect(readCloudEnv({}), why).toBeNull()
    expect(readCloudEnv({ [CLOUD_KEY_FILE_VAR]: '' }), why).toBeNull()
  })
})

describe('a Cloud Reach that was meant and does not work [fence:cloud-refuses-only-a-named-path]', () => {
  const WHY =
    'A path that was named and does not work refuses the boot, and never reads as no Cloud ' +
    'Reach (ADR-0015 §9). A mistyped path that fell through would present as the ' +
    'capability being absent, a diagnosis nobody can act on — and on a Google host it is one ' +
    "step from resolving roma's own identity (ADR-0015 §4) (#99)."

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

  it('says which path it was given', () => {
    const named = keyFile('not json at all')

    expect(() => readCloudEnv({ [CLOUD_KEY_FILE_VAR]: named })).toThrow(named)
  })
})
