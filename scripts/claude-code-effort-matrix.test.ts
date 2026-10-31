import { describe, expect, it } from 'vitest'
import { MENU } from '../src/model-menu.js'
import {
  effortMatrix,
  enclosingFunction,
  gateFor,
  matrixReport,
} from './claude-code-effort-matrix.js'

const EFFORT_GATE =
  'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;let r=lo(e);' +
  'if(r.includes("claude-3-")||r==="claude-opus-4-0"||r==="claude-opus-4-1"||' +
  'r==="claude-sonnet-4-0"||r==="claude-sonnet-4-5"||r==="claude-haiku-4-5")return!1;' +
  'if(Z.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)return!0;' +
  'if(M$(r,"effort")||r==="claude-mythos-5")return!0;return dj(ny(e))}'

const XHIGH_GATE =
  'function I_e(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;' +
  'let r=lo(e);if(r.includes("claude-3-")||r==="claude-opus-4-0"||r==="claude-opus-4-1"||' +
  'r==="claude-opus-4-5"||r==="claude-opus-4-6"||r==="claude-sonnet-4-0"||' +
  'r==="claude-sonnet-4-5"||r==="claude-sonnet-4-6"||r==="claude-haiku-4-5")return!1;' +
  'if(M$(r,"xhigh_effort")||r==="claude-mythos-5")return!0;return dj(ny(e))}'

const MAX_GATE =
  'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;' +
  'let r=lo(e);if(r.includes("claude-3-")||r==="claude-opus-4-0"||r==="claude-opus-4-1"||' +
  'r==="claude-opus-4-5"||r==="claude-sonnet-4-0"||r==="claude-sonnet-4-5"||' +
  'r==="claude-haiku-4-5")return!1;if(M$(r,"max_effort")||r==="claude-mythos-5")return!0;' +
  'return dj(ny(e))}'

const BUNDLE =
  'function pvi(){return Ot.perTurnEffortOkEmitted}' +
  EFFORT_GATE +
  XHIGH_GATE +
  MAX_GATE +
  'function ENr(e){return Ot.inferenceProfileBackingModels.get(e)}'

describe('finding a gate in the bundle', () => {
  it('reads one gate without reading into the one beside it', () => {
    const gate = gateFor(BUNDLE, 'effort')

    expect(gate.source).toBe(EFFORT_GATE)
    expect(gate.refused).not.toContain('claude-opus-4-6')
  })

  it('accepts a flag passed twice inside one function', () => {
    expect(EFFORT_GATE.match(/"effort"/g)).toHaveLength(2)
    expect(gateFor(BUNDLE, 'effort').source).toBe(EFFORT_GATE)
  })

  it('splits the models by the branch each one is compared on', () => {
    const gate = gateFor(BUNDLE, 'effort')

    expect(gate.refused).toContain('claude-haiku-4-5')
    expect(gate.allowed).toEqual(['claude-mythos-5'])
  })

  it('refuses a bundle that does not pass the flag at all', () => {
    expect(() => gateFor('function OI(e){return dj(ny(e))}', 'effort')).toThrow(/has moved/)
  })

  it('refuses a flag whose call sites are in different functions', () => {
    const split = `function a(e){return Ede(e,"effort")}function b(e){return M$(e,"effort")}`

    expect(() => gateFor(split, 'effort')).toThrow(/spread across 2 functions/)
  })

  it('refuses a call site that is not inside a block at all', () => {
    expect(() => enclosingFunction('let t=Ede(e,"effort")', 12, 'effort')).toThrow(
      /not inside a block/,
    )
  })

  it('refuses a block that never closes, which is a file cut short', () => {
    expect(() => enclosingFunction('function OI(e){let t=Ede(e,"effort");', 20, 'effort')).toThrow(
      /never closes/,
    )
  })
})

describe('the matrix it reports', () => {
  it('reports the Menu’s models as the gates name them, and unnamed where they do not', () => {
    const { rows } = effortMatrix(BUNDLE, Object.values(MENU))

    expect(rows).toEqual([
      { model: 'claude-fable-5', takes: { effort: null, xhigh_effort: null, max_effort: null } },
      { model: 'claude-opus-5', takes: { effort: null, xhigh_effort: null, max_effort: null } },
      { model: 'claude-sonnet-5', takes: { effort: null, xhigh_effort: null, max_effort: null } },
      {
        model: 'claude-haiku-4-5',
        takes: { effort: false, xhigh_effort: false, max_effort: false },
      },
    ])
  })

  it('hands back the gates it read them from, so the report and the rows agree', () => {
    const { gates } = effortMatrix(BUNDLE, Object.values(MENU))

    expect(gates.map(({ flag }) => flag)).toEqual(['effort', 'xhigh_effort', 'max_effort'])
    expect(gates.map(({ source }) => source)).toEqual([EFFORT_GATE, XHIGH_GATE, MAX_GATE])
  })
})

describe('the report a person reads', () => {
  const { rows, gates } = effortMatrix(BUNDLE, Object.values(MENU))
  const report = matrixReport(rows, gates)

  it('prints every gate it read, whole', () => {
    for (const gate of [EFFORT_GATE, XHIGH_GATE, MAX_GATE]) expect(report).toContain(gate)
  })

  it('says out loud that an unnamed model is not a refusal', () => {
    expect(report).toContain('is not a no')
  })

  it('says out loud that nothing consumes it', () => {
    expect(report).toContain('Nothing consumes this')
  })

  it('refuses a report with no models in it', () => {
    expect(() => matrixReport([], gates)).toThrow(/no models/)
  })
})
