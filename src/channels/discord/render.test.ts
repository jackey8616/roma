import { describe, expect, it } from 'vitest'
import { MAX_TEXT, outcomeMessages } from './render.js'

const GRANT = {
  kind: 'cloud-grant',
  taskId: 't',
  conversationKey: 'k',
  caller: '17',
  callerName: 'Ada',
  grant: {
    name: 'projects/p1/locations/global/entitlements/read/grants/g1',
    state: 'APPROVAL_AWAITED',
    entitlement: 'projects/p1/locations/global/entitlements/read',
    approveAt: 'https://console.example.test/approve',
    bindings: [],
    resource: null,
  },
  entitlement: {
    name: 'projects/p1/locations/global/entitlements/read',
    bindings: [{ role: 'roles/storage.objectViewer', condition: null }],
    maxDurationS: 3600,
  },
  durationS: 7200,
  justification: 'roma Task t: read the export',
} as const

describe('a Cloud Grant on Discord', () => {
  it('names what was asked for and where to approve it, in the text itself', () => {
    const [text] = outcomeMessages(GRANT)

    expect(text).toContain('Entitlement: projects/p1/locations/global/entitlements/read')
    expect(text).toContain('For: 2h')
    expect(text).toContain('roles/storage.objectViewer, with no condition')
    expect(text).toContain(
      'Approve or deny it in Google Cloud: https://console.example.test/approve',
    )
  })

  it('leaves the approval line off when there is no page', () => {
    const [text] = outcomeMessages({ ...GRANT, grant: { ...GRANT.grant, approveAt: null } })

    expect(text).not.toContain('Approve or deny')
  })
})

describe('the justification of a Cloud Grant on Discord', () => {
  const LONG = `roma Task t: ${'read the export '.repeat(62)}`

  it('keeps it within one message, whatever comes before it [fence:discord-grant-justification-not-split]', () => {
    for (let roles = 0; roles < 60; roles += 1) {
      const bindings = Array.from({ length: roles }, (_, at) => ({
        role: `roles/custom.role${String(at)}`,
        condition: null,
      }))
      const messages = outcomeMessages({
        ...GRANT,
        grant: { ...GRANT.grant, bindings },
        justification: LONG,
      })

      expect(messages.every((text) => text.length <= MAX_TEXT)).toBe(true)
      expect(
        messages.filter((text) => text.includes(`\`${LONG.trim()}\``)),
        `Split inside its code span, the rest of the justification opens the next message ` +
          `as plain text, outside the label and the span (#227). ${String(roles)} roles.`,
      ).toHaveLength(1)
    }
  })
})
