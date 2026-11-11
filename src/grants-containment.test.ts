import { describe, expect, it } from 'vitest'
import { matching, sources } from '../test/support/sources.js'

const APPROVES = [/:approve\b/, /\bapproveGrant\b/, /:deny\b/, /\bdenyGrant\b/]

describe('roma asks for a Cloud Grant and never decides one', () => {
  it('has no code that could approve or deny a grant [fence:roma-never-approves-a-cloud-grant]', () => {
    const offenders = matching(sources(), APPROVES)

    expect(
      offenders.map(({ file }) => file),
      'roma requests a Cloud Grant as the Cloud Reach and a person approves it in Google Cloud ' +
        '(ADR-0041 §3). Code that calls approve or deny would make roma the approver of its own ' +
        'requests the moment an entitlement listed the Cloud Reach among its approvers.',
    ).toEqual([])
  })

  it('would notice, which is why a line that approves trips it', () => {
    expect(
      matching([{ file: 'x.ts', source: 'fetch(`${grant}:approve`)' }], APPROVES),
    ).toHaveLength(1)
  })
})
