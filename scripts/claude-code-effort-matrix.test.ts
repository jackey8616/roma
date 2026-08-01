import { describe, expect, it } from 'vitest'
import { MENU } from '../src/model-menu.js'
import {
  effortMatrix,
  enclosingFunction,
  gateFor,
  matrixReport,
} from './claude-code-effort-matrix.js'

/**
 * The three gates, exactly as they are minified in Claude Code 2.1.220.
 *
 * Copied out of the pinned bundle rather than written to suit the extractor,
 * which is the only way this file proves anything: the reading being asserted is
 * a reading of the real thing, and a fixture somebody tidied would be the
 * extractor testing its own assumptions. Their names are `OI`, `I_e` and `eqe`
 * in this build and will be something else in the next one — which is exactly
 * why nothing here anchors on them.
 */
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

/**
 * The gates as they really sit: one after another, with unrelated code around
 * them.
 *
 * The neighbour is the point of the fixture. In the bundle these three functions
 * are adjacent with no separator, so an extractor that reads by byte distance
 * rather than by brace balance walks straight out of one and into the next —
 * which is the failure ADR-0016 records, and which this file exists to keep from
 * recurring.
 */
const BUNDLE =
  'function pvi(){return Ot.perTurnEffortOkEmitted}' +
  EFFORT_GATE +
  XHIGH_GATE +
  MAX_GATE +
  'function ENr(e){return Ot.inferenceProfileBackingModels.get(e)}'

describe('finding a gate in the bundle', () => {
  // The whole safety property. Each gate names models the ones beside it do not
  // — `claude-opus-4-6` is in the xhigh gate and in neither of the others — so a
  // window that overran would show up here as the neighbour's models appearing
  // in this one's lists.
  it('reads one gate without reading into the one beside it', () => {
    const gate = gateFor(BUNDLE, 'effort')

    expect(gate.source).toBe(EFFORT_GATE)
    expect(gate.refused).not.toContain('claude-opus-4-6')
  })

  // Two call sites inside one function is the normal shape rather than an
  // ambiguity: the flag name is asked of the deployment's flag store and then of
  // the model's entitlements. What must be one is the function, not the site.
  it('accepts a flag passed twice inside one function', () => {
    expect(EFFORT_GATE.match(/"effort"/g)).toHaveLength(2)
    expect(gateFor(BUNDLE, 'effort').source).toBe(EFFORT_GATE)
  })

  it('splits the models by the branch each one is compared on', () => {
    const gate = gateFor(BUNDLE, 'effort')

    expect(gate.refused).toContain('claude-haiku-4-5')
    // The case the first version of this extractor got wrong, and the reason
    // ADR-0016 will not let it gate anything: read out of the neighbouring
    // function, `claude-mythos-5` came back as unsupported when it is on the
    // allowing branch.
    expect(gate.allowed).toEqual(['claude-mythos-5'])
  })

  // A build whose shape has moved is the thing worth being told about. Coping
  // with it quietly is how an extractor comes to watch nothing while printing a
  // table that reads as an answer.
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
  // What the pinned build actually says about roma's own three models, and the
  // distinction the whole three-valued design exists for: one is refused by
  // name, and the other two are named on neither branch — so what decides them
  // is a server-side entitlement this cannot see. `EFFORT_MATRIX` says `true`
  // for those two on a person's reading of other evidence, which is the
  // relationship ADR-0016 designed rather than a disagreement.
  it('reports the Menu’s models as the gates name them, and unnamed where they do not', () => {
    const { rows } = effortMatrix(BUNDLE, Object.values(MENU))

    expect(rows).toEqual([
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

  // Printed in full, because the table is the part that can be wrong. A table
  // with no source under it asks to be believed.
  it('prints every gate it read, whole', () => {
    for (const gate of [EFFORT_GATE, XHIGH_GATE, MAX_GATE]) expect(report).toContain(gate)
  })

  // The sentence that stops the next reader making the mistake the extractor
  // made. An em dash that reads as "no" would put two models on the wrong row of
  // a constant nothing else checks.
  it('says out loud that an unnamed model is not a refusal', () => {
    expect(report).toContain('is not a no')
  })

  it('says out loud that nothing consumes it', () => {
    expect(report).toContain('Nothing consumes this')
  })

  // A report with an empty table reads as "nothing takes an effort", which is
  // the one answer that must never be arrived at by accident.
  it('refuses a report with no models in it', () => {
    expect(() => matrixReport([], gates)).toThrow(/no models/)
  })
})
