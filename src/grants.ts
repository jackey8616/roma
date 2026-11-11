export interface RoleBinding {
  readonly role: string
  readonly condition: string | null
}

export interface Entitlement {
  readonly name: string
  readonly bindings: readonly RoleBinding[]
  readonly maxDurationS: number
}

export interface GrantAsked {
  readonly entitlement: string
  readonly durationS: number
  readonly justification: string
}

export interface Grant {
  readonly name: string
  readonly state: string
  readonly entitlement: string
  readonly approveAt: string | null
  readonly bindings: readonly RoleBinding[]
  readonly resource: string | null
}

export interface CloudGrantAsked {
  readonly grant: Grant
  readonly entitlement: Entitlement
  readonly durationS: number
  readonly justification: string
}

export interface RequestsGrants {
  entitlements(): readonly Entitlement[]
  request(asked: GrantAsked): Promise<Grant>
  status(name: string): Promise<Grant>
}

export type Grants = { readonly requests: RequestsGrants } | { readonly unavailable: string }

export const SHORTEST_GRANT_S = 1800

export const LONGEST_JUSTIFICATION = 1000

export type Checked<T> = { readonly ok: T } | { readonly refused: string }

export function stampedFor(taskId: string, justification: string): string {
  return `roma Task ${taskId}: ${justification}`
}

export function entitlementNamed(
  named: string,
  entitlements: readonly Entitlement[],
): Checked<Entitlement> {
  const exact = entitlements.find(({ name }) => name === named)
  if (exact !== undefined) return { ok: exact }
  const byId = entitlements.filter(({ name }) => name.endsWith(`/entitlements/${named}`))
  if (byId.length === 1) return { ok: byId[0]! }
  if (byId.length > 1) {
    return {
      refused:
        `"${named}" names ${String(byId.length)} entitlements in different places; ` +
        `give the whole name, one of: ${byId.map(({ name }) => name).join(', ')}.`,
    }
  }
  return {
    refused:
      `"${named}" is not an entitlement roma found for its Cloud Reach at boot. ` +
      `It may ask for: ${entitlements.map(({ name }) => name).join(', ') || 'nothing'}.`,
  }
}

export function checkedGrant(
  asked: GrantAsked,
  taskId: string | null,
  entitlements: readonly Entitlement[],
): Checked<GrantAsked> {
  if (taskId === null) {
    return {
      refused:
        'a Cloud Grant is asked for by a Task, and no Task is running in this Session, ' +
        'so there is nobody it could be traced back to.',
    }
  }
  const found = entitlementNamed(asked.entitlement, entitlements)
  if ('refused' in found) return found
  const entitlement = found.ok

  if (!Number.isInteger(asked.durationS) || asked.durationS < SHORTEST_GRANT_S) {
    return {
      refused: `a Cloud Grant lasts at least ${String(SHORTEST_GRANT_S)} seconds, which Google sets and roma cannot change.`,
    }
  }
  if (asked.durationS > entitlement.maxDurationS) {
    return {
      refused:
        `${entitlement.name} allows at most ${String(entitlement.maxDurationS)} seconds, ` +
        `and ${String(asked.durationS)} were asked for.`,
    }
  }

  const justification = asked.justification.trim()
  if (justification === '') {
    return {
      refused:
        'a Cloud Grant needs a justification: it is the sentence the person approving it reads.',
    }
  }
  if (justification.length > LONGEST_JUSTIFICATION) {
    return {
      refused: `a justification is at most ${String(LONGEST_JUSTIFICATION)} characters, and this one is ${String(justification.length)}.`,
    }
  }

  return {
    ok: {
      entitlement: entitlement.name,
      durationS: asked.durationS,
      justification: stampedFor(taskId, justification),
    },
  }
}

export function grantNamed(named: string, entitlements: readonly Entitlement[]): Checked<string> {
  const under = entitlements.some(({ name }) => named.startsWith(`${name}/grants/`))
  if (under && !named.slice(named.indexOf('/grants/') + '/grants/'.length).includes('/')) {
    return { ok: named }
  }
  return {
    refused: `"${named}" is not a grant under any entitlement roma found for its Cloud Reach.`,
  }
}

export function grantNotice({ grant, entitlement, durationS, justification }: CloudGrantAsked): {
  readonly lines: readonly string[]
  readonly approveAt: string | null
} {
  const fromGrant = grant.bindings.length > 0
  const bindings = fromGrant ? grant.bindings : entitlement.bindings
  return {
    lines: [
      'roma asked Google Cloud for a Cloud Grant for this task. Nothing is widened until a ' +
        'person approves it there.',
      'While it lasts, every Conversation with this roma has these roles, not only this one.',
      `• Entitlement: ${entitlement.name}`,
      ...(grant.resource === null ? [] : [`• On: ${grant.resource}`]),
      ...(bindings.length === 0
        ? ['• Roles: none named']
        : bindings.map((binding) => `• ${bindingWords(binding)}`)),
      ...(fromGrant
        ? []
        : [
            '• (Google named no roles on the grant, so these are the entitlement’s as roma found it at boot.)',
          ]),
      `• For: ${durationWords(durationS)}`,
      `• State: ${grant.state}`,
      `• Grant: ${grant.name}`,
      `• Justification, written by the agent and not checked by roma: ${justification}`,
    ],
    approveAt: grant.approveAt,
  }
}

export function bindingWords({ role, condition }: RoleBinding): string {
  return condition === null ? `${role}, with no condition` : `${role}, only where ${condition}`
}

function durationWords(seconds: number): string {
  if (seconds % 3600 === 0) return `${String(seconds / 3600)}h`
  if (seconds % 60 === 0) return `${String(seconds / 60)}m`
  return `${String(seconds)}s`
}
