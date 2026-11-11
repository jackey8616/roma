import { describe, expect, it } from 'vitest'
import {
  checkedGrant,
  entitlementNamed,
  grantNamed,
  grantNotice,
  LONGEST_JUSTIFICATION,
  SHORTEST_GRANT_S,
  type Entitlement,
} from './grants.js'

const READ_BUCKET: Entitlement = {
  name: 'projects/p1/locations/global/entitlements/read-bucket',
  roles: ['roles/storage.objectViewer'],
  conditions: ['resource.name == "projects/_/buckets/b"'],
  maxDurationS: 3600,
}

const READ_BUCKET_ELSEWHERE: Entitlement = {
  ...READ_BUCKET,
  name: 'folders/9/locations/global/entitlements/read-bucket',
}

const DEPLOY: Entitlement = {
  name: 'projects/p1/locations/global/entitlements/deploy',
  roles: ['roles/run.developer'],
  conditions: [],
  maxDurationS: 7200,
}

const asked = {
  entitlement: 'read-bucket',
  durationS: SHORTEST_GRANT_S,
  justification: 'read the export the Caller asked about',
}

describe('a Cloud Grant carries the Task that asked for it', () => {
  it('stamps the Task id ahead of the justification [fence:cloud-grant-carries-its-task]', () => {
    const checked = checkedGrant(asked, 'task-42', [READ_BUCKET, DEPLOY])

    expect(checked).toEqual({
      ok: {
        entitlement: READ_BUCKET.name,
        durationS: SHORTEST_GRANT_S,
        justification: 'roma Task task-42: read the export the Caller asked about',
      },
    })
  })

  it('refuses when no Task is running, since nothing could trace it back', () => {
    const checked = checkedGrant(asked, null, [READ_BUCKET])

    expect(checked).toMatchObject({ refused: expect.stringContaining('no Task is running') })
  })
})

describe('roma asks only for what it found at boot', () => {
  it('refuses an entitlement it did not find [fence:cloud-grant-only-from-what-roma-found]', () => {
    const checked = checkedGrant(
      { ...asked, entitlement: 'projects/p1/locations/global/entitlements/owner' },
      'task-1',
      [READ_BUCKET, DEPLOY],
    )

    expect(checked).toMatchObject({ refused: expect.stringContaining('is not an entitlement') })
  })

  it('takes the whole name, or the last part of it when that is unique', () => {
    expect(entitlementNamed(DEPLOY.name, [READ_BUCKET, DEPLOY])).toEqual({ ok: DEPLOY })
    expect(entitlementNamed('deploy', [READ_BUCKET, DEPLOY])).toEqual({ ok: DEPLOY })
  })

  it('asks for the whole name when the last part is in two places', () => {
    const found = entitlementNamed('read-bucket', [READ_BUCKET, READ_BUCKET_ELSEWHERE])

    expect(found).toMatchObject({ refused: expect.stringContaining('give the whole name') })
  })

  it('does not take a name that only ends the same way', () => {
    expect(entitlementNamed('bucket', [READ_BUCKET])).toMatchObject({
      refused: expect.any(String),
    })
  })
})

describe('the duration and the justification', () => {
  it('refuses less than Google’s shortest grant', () => {
    expect(
      checkedGrant({ ...asked, durationS: SHORTEST_GRANT_S - 1 }, 't', [READ_BUCKET]),
    ).toMatchObject({ refused: expect.stringContaining('at least') })
  })

  it('refuses more than the entitlement allows', () => {
    expect(checkedGrant({ ...asked, durationS: 3601 }, 't', [READ_BUCKET])).toMatchObject({
      refused: expect.stringContaining('at most 3600 seconds'),
    })
  })

  it('refuses a duration that is not a whole number of seconds', () => {
    expect(checkedGrant({ ...asked, durationS: 1800.5 }, 't', [READ_BUCKET])).toMatchObject({
      refused: expect.any(String),
    })
  })

  it('refuses an empty justification, which is what the approver reads', () => {
    expect(checkedGrant({ ...asked, justification: '   ' }, 't', [READ_BUCKET])).toMatchObject({
      refused: expect.stringContaining('needs a justification'),
    })
  })

  it('refuses a justification longer than roma passes on', () => {
    const justification = 'x'.repeat(LONGEST_JUSTIFICATION + 1)

    expect(checkedGrant({ ...asked, justification }, 't', [READ_BUCKET])).toMatchObject({
      refused: expect.stringContaining('at most'),
    })
  })
})

describe('asking after a grant', () => {
  it('takes a grant under an entitlement roma found', () => {
    const name = `${READ_BUCKET.name}/grants/abc-123`

    expect(grantNamed(name, [READ_BUCKET])).toEqual({ ok: name })
  })

  it('refuses a grant anywhere else', () => {
    expect(
      grantNamed('projects/p1/locations/global/entitlements/owner/grants/abc', [READ_BUCKET]),
    ).toMatchObject({ refused: expect.any(String) })
  })

  it('refuses a path that only starts like a grant', () => {
    expect(grantNamed(`${READ_BUCKET.name}/grants/abc/extra`, [READ_BUCKET])).toMatchObject({
      refused: expect.any(String),
    })
  })
})

describe('what roma says about a Cloud Grant it asked for', () => {
  it('says nothing is widened yet, and marks the justification as the agent’s', () => {
    const { lines, approveAt } = grantNotice({
      grant: {
        name: `${READ_BUCKET.name}/grants/g1`,
        state: 'APPROVAL_AWAITED',
        entitlement: READ_BUCKET.name,
        approveAt: 'https://console.example.test/approve',
      },
      entitlement: READ_BUCKET,
      durationS: 5400,
      justification: 'roma Task t: read the export',
    })

    expect(lines[0]).toContain('Nothing is widened until a person approves it')
    expect(lines).toContain('• For: 90m')
    expect(lines).toContain('• State: APPROVAL_AWAITED')
    expect(lines.at(-1)).toBe(
      '• Justification, written by the agent and not checked by roma: roma Task t: read the export',
    )
    expect(approveAt).toBe('https://console.example.test/approve')
  })
})
