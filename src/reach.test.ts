import { describe, expect, it } from 'vitest'
import {
  FakeCloudMinter,
  FakeDocumentMinter,
  FakeMinter,
  fakeReaches,
} from '../test/support/fake-minter.js'
import { cloudReach, cloudReachFrom, NO_CLOUD_REACH } from './cloud/reach.js'
import { documentReach, documentReachFrom, NO_DOCUMENT_REACH } from './documents/reach.js'
import { ConfigurationMissing } from './env-config.js'
import { githubReach } from './github/reach.js'
import { eachReach, type Reach, type Reaches } from './reach.js'

const REVOKED = new Error('the key was revoked')

/**
 * The three real Reaches, each with a key that does not work.
 *
 * The real factories rather than the fixtures `startup.test.ts` boots with: the
 * forge's fixture reimplements `prove`, so a `githubReach` that swallowed a
 * failure would pass every boot test there.
 */
describe('a Reach whose key does not work [fence:reach-a-broken-key-blocks-the-boot]', () => {
  const WHY =
    'prove() must throw for a Reach that is configured and does not work, and never answer ' +
    'as the unavailable arm (ADR-0020 §2, ADR-0015 §8, ADR-0008). A revoked key reported as ' +
    '"this deployment has no such Reach" is a lie told to every Session, and boot goes on to ' +
    "fail inside somebody's paid Turn as an inexplicable `git clone` or 401 with no " +
    'diagnosis attached (#62, #119, #132).'

  it('stops the boot for the forge', async () => {
    const reach = githubReach(new FakeMinter({ failsWith: REVOKED }))

    await expect(reach.prove(), WHY).rejects.toThrow('the key was revoked')
  })

  it('stops the boot for the cloud, in the shape every configuration problem takes', async () => {
    const reach = cloudReach(new FakeCloudMinter({ failsWith: REVOKED }))

    await expect(reach.prove(), WHY).rejects.toThrow(ConfigurationMissing)
    await expect(reach.prove(), WHY).rejects.toThrow('the key was revoked')
  })

  it('stops the boot for the documents, before asking Drive anything', async () => {
    const minter = new FakeDocumentMinter({ failsWith: REVOKED })
    const reach = documentReach(minter)

    await expect(reach.prove(), WHY).rejects.toThrow(ConfigurationMissing)
    await expect(reach.prove(), WHY).rejects.toThrow('the key was revoked')
    expect(minter.depots, WHY).toBe(0)
  })
})

describe('a Reach announces only what it proved [fence:reach-announces-only-what-it-proved]', () => {
  const WHY =
    'announce() before prove() must throw rather than default (ADR-0020). The empty forge ' +
    'announcement tells the agent it reaches no repositories, and the unproved Depot ' +
    'announcement names a folder roma never established it can write to: an agent told ' +
    'either stops trying, or spends a Turn finding out from a 403 (#119, #132).'

  it('refuses to announce the forge before proving it', () => {
    expect(() => githubReach(new FakeMinter()).announce(), WHY).toThrow(/before proving/)
  })

  it('refuses to announce the Depot before proving it', () => {
    expect(() => documentReach(new FakeDocumentMinter()).announce(), WHY).toThrow(/before proving/)
  })
})

describe('a deployment with no key [fence:reach-no-key-is-a-reach-that-says-so]', () => {
  const WHY =
    'A deployment with no key still has the Reach, as its unavailable arm carrying the ' +
    'sentence roma answers with (ADR-0015 §9, ADR-0022 §8). A Reach that were simply absent ' +
    'reads to whatever consults it as one that does not apply, and the agent, met with ' +
    '`command not found`, spends a Turn investigating its `PATH` (#119).'

  it('has a Cloud Reach that says there is none', () => {
    const reach: Reach<'cloud'> = cloudReachFrom(null)

    expect(reach.credential, WHY).toBe('cloud')
    expect('unavailable' in reach && reach.unavailable, WHY).toBe(NO_CLOUD_REACH)
  })

  it('has a Document Reach that says there is none', () => {
    const reach: Reach<'documents'> = documentReachFrom(null)

    expect(reach.credential, WHY).toBe('documents')
    expect('unavailable' in reach && reach.unavailable, WHY).toBe(NO_DOCUMENT_REACH)
  })

  // The type half, which is the rung that holds it: if `Reaches` ever let a
  // member be absent or null, these would compile and the directives would fail
  // `npm run typecheck`.
  it('cannot be written as a missing Reach', () => {
    const { code, cloud, documents } = fakeReaches()

    // @ts-expect-error -- a deployment with no Cloud Reach still has its unavailable arm
    const noCloud: Reaches = { code, documents }
    // @ts-expect-error -- null is an absence, and the Reach must be present
    const nullCloud: Reaches = { code, cloud: null, documents }
    // @ts-expect-error -- a deployment with no Document Reach still has its unavailable arm
    const noDocuments: Reaches = { code, cloud }

    expect([noCloud, nullCloud, noDocuments], WHY).toHaveLength(3)
  })
})

describe('one Reach per credential [fence:reach-one-per-credential]', () => {
  // A list cannot say "one per credential". `Reaches` is a record over the
  // closed `CredentialWanted`, so leaving the forge out does not compile.
  it('cannot be assembled without the forge', () => {
    const { cloud, documents } = fakeReaches()

    // @ts-expect-error -- `code` is required: there is no mode that skips the forge credential
    const noCode: Reaches = { cloud, documents }
    // @ts-expect-error -- the forge's slot takes the forge's Reach and no other
    const wrongSlot: Reaches = { code: cloud, cloud, documents }

    expect(
      [noCode, wrongSlot],
      'Reaches is total over CredentialWanted, and `code` is an AvailableReach (ADR-0008, ' +
        'ADR-0020). A roma with no code Reach proves no key at boot and fails every git ' +
        "request inside somebody's Turn — the failure blocking the boot exists to prevent (#119).",
    ).toHaveLength(2)
  })
})

describe('the order Reaches are proved in [fence:reach-code-is-proved-first]', () => {
  it('is the forge first, then the cloud, then the documents', () => {
    const reaches = fakeReaches({
      cloudMinter: new FakeCloudMinter(),
      documentMinter: new FakeDocumentMinter(),
    })

    expect(
      eachReach(reaches).map(({ credential }) => credential),
      'Reaches are proved and announced code first, and the order is load-bearing rather than ' +
        'alphabetical (ADR-0020 §4). The forge check is free: a deployment broken in several ' +
        'ways is told about it first, and a boot with a bad App key makes no network call to ' +
        'Google at all (#132).',
    ).toEqual(['code', 'cloud', 'documents'])
  })
})

describe('a Reach fills only its own credential slot [fence:reach-typed-by-its-credential]', () => {
  it('cannot be wired backwards', () => {
    const code = githubReach(new FakeMinter())
    const cloud = cloudReach(new FakeCloudMinter())
    const { documents } = fakeReaches()

    // @ts-expect-error -- a Reach is typed by its credential: the forge's slot refuses an available Cloud Reach
    const backwards: Reaches = { code: cloud, cloud: code, documents }

    expect(
      [backwards],
      'A Reach is typed by the credential it answers for, not by the bare union (ADR-0020 §3). ' +
        'Without the type parameter a total, populated record wired backwards typechecks, and ' +
        '`git` is handed a Cloud Token: everything looks like it works until the first API ' +
        'call (#119).',
    ).toHaveLength(1)
  })
})
