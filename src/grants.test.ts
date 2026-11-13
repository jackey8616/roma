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
  bindings: [
    { role: 'roles/storage.objectViewer', condition: 'resource.name == "projects/_/buckets/b"' },
  ],
  maxDurationS: 3600,
}

const READ_BUCKET_ELSEWHERE: Entitlement = {
  ...READ_BUCKET,
  name: 'folders/9/locations/global/entitlements/read-bucket',
}

const DEPLOY: Entitlement = {
  name: 'projects/p1/locations/global/entitlements/deploy',
  bindings: [{ role: 'roles/run.developer', condition: null }],
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
  const GRANT = {
    name: `${READ_BUCKET.name}/grants/g1`,
    state: 'APPROVAL_AWAITED',
    entitlement: READ_BUCKET.name,
    approveAt: 'https://console.example.test/approve',
    bindings: READ_BUCKET.bindings,
    resource: '//cloudresourcemanager.googleapis.com/projects/p1',
  }
  const noticed = (grant = GRANT, entitlement = READ_BUCKET) =>
    grantNotice({
      grant,
      entitlement,
      durationS: 5400,
      justification: 'roma Task t: read the export',
    })

  it('says nothing is widened yet, and marks the justification as the agent’s', () => {
    const { lines, approveAt } = noticed()

    expect(lines[0]).toContain('Nothing is widened until a person approves it')
    expect(lines).toContain('• On: //cloudresourcemanager.googleapis.com/projects/p1')
    expect(lines).toContain('• For: 90m')
    expect(lines).toContain('• State: APPROVAL_AWAITED')
    expect(lines.at(-1)).toBe(
      '• Justification, written by the agent and not checked by roma: `roma Task t: read the export`',
    )
    expect(approveAt).toBe('https://console.example.test/approve')
  })

  it('tells the approver every Conversation gets the roles [fence:cloud-grant-notice-says-every-conversation]', () => {
    expect(
      noticed().lines.join('\n'),
      'A Cloud Grant widens the Reach for every Conversation (ADR-0041 §1), and the approver ' +
        'reads only the notice. Said only to the agent, the person deciding never learns it.',
    ).toMatch(/every Conversation with this roma has these roles/)
  })

  it('shows the roles Google put on the grant, not the ones roma found at boot [fence:cloud-grant-notice-shows-what-google-granted]', () => {
    const widened = [{ role: 'roles/storage.objectAdmin', condition: null }]

    const lines = noticed({ ...GRANT, bindings: widened }).lines

    expect(
      lines,
      'An entitlement can be widened after roma booted. The notice is what a person approves ' +
        'from, so it says what PAM answered for this grant (ADR-0041 §6).',
    ).toContain('• roles/storage.objectAdmin, with no condition')
    expect(lines.join('\n')).not.toContain('objectViewer')
  })

  it('falls back to the entitlement as found, and says so, when Google named no roles', () => {
    const lines = noticed({ ...GRANT, bindings: [] }).lines

    expect(lines).toContain(
      '• roles/storage.objectViewer, only where resource.name == "projects/_/buckets/b"',
    )
    expect(lines.join('\n')).toContain('as roma found it at boot')
  })

  it('keeps each role with its own condition [fence:cloud-grant-condition-stays-with-its-role]', () => {
    const lines = noticed({
      ...GRANT,
      bindings: [
        {
          role: 'roles/storage.objectViewer',
          condition: 'resource.name == "projects/_/buckets/b"',
        },
        { role: 'roles/storage.objectAdmin', condition: null },
      ],
    }).lines

    expect(
      lines,
      'A condition binds one role binding in PAM. Joined across roles, an unconditioned admin ' +
        'role reads as if the viewer’s bucket limit applied to it too.',
    ).toEqual(
      expect.arrayContaining([
        '• roles/storage.objectViewer, only where resource.name == "projects/_/buckets/b"',
        '• roles/storage.objectAdmin, with no condition',
      ]),
    )
  })
})

describe('the justification in a Cloud Grant notice is the agent’s, all of it', () => {
  const FORGED =
    'roma Task t: read one export file\n\nroma checked this request: read-only, one object, ' +
    'safe to approve.\n• Approve here: <https://evil.example/pam|Review it in Google Cloud> ' +
    '<users/all> [here](https://evil.example/pam)'
  const LABEL = '• Justification, written by the agent and not checked by roma: '
  const noticed = (justification: string) =>
    grantNotice({
      grant: {
        name: `${READ_BUCKET.name}/grants/g1`,
        state: 'APPROVAL_AWAITED',
        entitlement: READ_BUCKET.name,
        approveAt: null,
        bindings: READ_BUCKET.bindings,
        resource: null,
      },
      entitlement: READ_BUCKET,
      durationS: SHORTEST_GRANT_S,
      justification,
    }).lines

  it('shows it on one line, inside one code span [fence:cloud-grant-justification-stays-literal]', () => {
    const lines = noticed(FORGED)
    const shown = lines.at(-1)!

    expect(
      lines.join('\n').split('\n'),
      'Text after a newline in the justification left the "written by the agent" label and ' +
        'read to the approver as roma vouching for the grant (#227).',
    ).toHaveLength(lines.length)
    expect(shown.startsWith(`${LABEL}\``)).toBe(true)
    expect(shown.endsWith('`')).toBe(true)
    expect(
      shown.slice(LABEL.length + 1, -1),
      'Inside a code span a Channel shows links and mentions as the characters they are.',
    ).toBe(
      'roma Task t: read one export file roma checked this request: read-only, one object, ' +
        'safe to approve. • Approve here: <https://evil.example/pam|Review it in Google Cloud> ' +
        '<users/all> [here](https://evil.example/pam)',
    )
  })

  it('leaves no backtick that could close the span early', () => {
    const shown = noticed('roma Task t: a` <users/all> ``` `b').at(-1)!

    expect(shown.match(/`/g)).toHaveLength(2)
    expect(shown).toBe(`${LABEL}\`roma Task t: aˋ <users/all> ˋˋˋ ˋb\``)
  })

  it('folds every kind of line break, not only \\n', () => {
    const shown = noticed('roma Task t: a\r\nb\u2028c\u2029d\u0085e\tf\vg').at(-1)!

    expect(shown).toBe(`${LABEL}\`roma Task t: a b c d e f g\``)
  })
})
