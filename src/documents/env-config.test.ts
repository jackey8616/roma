import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurationMissing } from '../env-config.js'
import { DOCUMENT_DEPOT_VAR, DOCUMENT_KEY_FILE_VAR, readDocumentEnv } from './env-config.js'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'roma-document-env-'))
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

  it('exchanges where the key says, and has an answer where it does not [fence:documents-exchanges-where-the-key-says]', () => {
    const why =
      "The token endpoint is the key file's own `token_uri`, defaulted only where the key " +
      'omits it (ADR-0022 §2, for the reason ADR-0015 gives). A hardcoded constant silently ' +
      'ignores a key that says otherwise; whoever can write the file can replace the whole ' +
      'key, so roma takes the endpoint from the key and from nowhere else (#132).'
    const named = keyFile(JSON.stringify({ ...A_KEY, token_uri: 'https://elsewhere.test/token' }))
    const { token_uri, ...silent } = A_KEY

    expect(
      readDocumentEnv({ [DOCUMENT_KEY_FILE_VAR]: named, [DOCUMENT_DEPOT_VAR]: DEPOT })
        ?.tokenEndpoint,
      why,
    ).toBe('https://elsewhere.test/token')
    expect(
      readDocumentEnv({
        [DOCUMENT_KEY_FILE_VAR]: keyFile(JSON.stringify(silent)),
        [DOCUMENT_DEPOT_VAR]: DEPOT,
      })?.tokenEndpoint,
      why,
    ).toBe('https://oauth2.googleapis.com/token')
  })
})

describe('a deployment with none', () => {
  it('is not a problem, and is not one when the variables are empty either', () => {
    expect(readDocumentEnv({})).toBeNull()
    expect(readDocumentEnv({ [DOCUMENT_KEY_FILE_VAR]: '', [DOCUMENT_DEPOT_VAR]: '' })).toBeNull()
  })
})

describe('a Document Reach configured halfway [fence:documents-both-variables-or-neither]', () => {
  const WHY =
    'Half a Document Reach refuses the boot, naming the other variable, and never reads as ' +
    'no Document Reach (ADR-0022 §2). A key with no Depot has nowhere to write and a Depot ' +
    'with no key is a folder nobody can reach; falling through, the deployment silently has ' +
    'no Reach and finds out from an agent saying it cannot write a document (#132).'

  it('refuses a key with no Depot, naming the variable that is missing', () => {
    const path = keyFile(JSON.stringify(A_KEY))

    expect(() => readDocumentEnv({ [DOCUMENT_KEY_FILE_VAR]: path }), WHY).toThrow(
      ConfigurationMissing,
    )
    expect(() => readDocumentEnv({ [DOCUMENT_KEY_FILE_VAR]: path }), WHY).toThrow(
      DOCUMENT_DEPOT_VAR,
    )
  })

  it('refuses a Depot with no key, naming the variable that is missing', () => {
    expect(() => readDocumentEnv({ [DOCUMENT_DEPOT_VAR]: DEPOT }), WHY).toThrow(
      ConfigurationMissing,
    )
    expect(() => readDocumentEnv({ [DOCUMENT_DEPOT_VAR]: DEPOT }), WHY).toThrow(
      DOCUMENT_KEY_FILE_VAR,
    )
  })

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

  it('says which path it was given', () => {
    const named = keyFile('not json at all')

    expect(() =>
      readDocumentEnv({ [DOCUMENT_KEY_FILE_VAR]: named, [DOCUMENT_DEPOT_VAR]: DEPOT }),
    ).toThrow(named)
  })

  it('takes the Depot as given, since only the boot proof can check one', () => {
    const path = keyFile(JSON.stringify(A_KEY))

    expect(
      readDocumentEnv({ [DOCUMENT_KEY_FILE_VAR]: path, [DOCUMENT_DEPOT_VAR]: 'not-a-folder-id' })
        ?.depot,
    ).toBe('not-a-folder-id')
  })
})
