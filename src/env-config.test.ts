import { describe, expect, it } from 'vitest'
import { CAVEMAN_MENU, OFF_MENU_WENYAN } from './caveman.js'
import { readDiscordEnv } from './channels/discord/env-config.js'
import { readChatEnv } from './channels/google-chat/env-config.js'
import {
  ConfigurationMissing,
  readConfiguration,
  readRomaEnv,
  type Environment,
} from './env-config.js'

/** Everything roma insists on, and nothing it does not. */
const MINIMAL = {
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
  ROMA_WORK_ROOT: '/srv/roma/sessions',
  ROMA_AUDIT_ROOT: '/var/lib/roma/audit',
  ROMA_CLAUDE_CONFIG_DIR: '/srv/roma/claude',
  ROMA_SHIM_DIR: '/run/roma',
}

const CAVEMAN =
  'ROMA_CAVEMAN must be validated here, exactly — never passed through, folded or trimmed, and ' +
  '`wenyan` is refused rather than folded into wenyan-full (ADR-0030, #192). Nothing downstream ' +
  'would ever see the level: unrefused, it appends caveman’s ruleset with an empty intensity ' +
  'table to every Session, in silence.'

const OVERFLOW =
  'Overflow must exist only when both its halves do, read from names of roma’s own (ADR-0002, ' +
  '#28). A metered key with no cap spends without bound; a cap with no key offers a valve with ' +
  'nothing behind it; and ANTHROPIC_API_KEY is set on developer machines and CI images for ' +
  'unrelated reasons, so reading it would switch metered billing on because a shell profile ' +
  'mentioned it.'

describe('reading roma out of the environment', () => {
  it('reads the Shared Window credential and the three directories', () => {
    expect(readRomaEnv(MINIMAL)).toEqual({
      credential: { kind: 'shared-window', oauthToken: 'oauth-token' },
      workRoot: '/srv/roma/sessions',
      auditRoot: '/var/lib/roma/audit',
      configDir: '/srv/roma/claude',
      shimDir: '/run/roma',
    })
  })

  // Every one of them, not the first. Standing roma up means setting all of
  // these, and a reader that stopped at the first missing one would make that a
  // sequence of boots, each failing on the next variable.
  it('names every variable that is missing, in one refusal', () => {
    expect(() => readRomaEnv({})).toThrow(ConfigurationMissing)

    try {
      readRomaEnv({})
    } catch (error) {
      expect((error as ConfigurationMissing).message).toContain('CLAUDE_CODE_OAUTH_TOKEN')
      expect((error as ConfigurationMissing).message).toContain('ROMA_WORK_ROOT')
      expect((error as ConfigurationMissing).message).toContain('ROMA_AUDIT_ROOT')
      expect((error as ConfigurationMissing).message).toContain('ROMA_CLAUDE_CONFIG_DIR')
      expect((error as ConfigurationMissing).message).toContain('ROMA_SHIM_DIR')
    }
  })

  // Refused on its own and not only alongside everything else, because the
  // deployment this is here for is the one that set every other variable.
  // ADR-0005 makes the Transcript the only record of what an agent did, which
  // needs roma to have named where it lives — unset, `HOME` is on `buildEnv`'s
  // passthrough list and every Session's lands in the host user's own
  // `~/.claude/projects/`, in a directory roma never reclaims.
  it('refuses to start without somewhere of roma’s own for the Transcript', () => {
    const { ROMA_CLAUDE_CONFIG_DIR: _omitted, ...withoutIt } = MINIMAL

    expect(() => readRomaEnv(withoutIt)).toThrow(/ROMA_CLAUDE_CONFIG_DIR/)
  })

  it.each([
    ['inside', '/srv/roma/sessions/audit'],
    ['deeper inside', '/srv/roma/sessions/a/b/audit'],
    ['that is', '/srv/roma/sessions/'],
    ['inside, by a relative step,', '/srv/roma/sessions/../sessions/audit'],
  ])(
    'refuses an audit root %s the work root [fence:env-audit-root-outside-the-work-root]',
    (_, auditRoot) => {
      const why =
        'ROMA_AUDIT_ROOT must be refused when it is under ROMA_WORK_ROOT (ADR-0002, #31). The ' +
        'work root is walked by a reclaim that deletes any directory nothing has touched for seven ' +
        'days, and appending to a month’s file does not touch its directory: the Audit Records — ' +
        'the only record of who spent what, which the provider cannot reconstruct — are deleted ' +
        'after a quiet week.'

      expect(() => readRomaEnv({ ...MINIMAL, ROMA_AUDIT_ROOT: auditRoot }), why).toThrow(
        /ROMA_AUDIT_ROOT/,
      )
    },
  )

  it('takes an audit root beside the work root, whose name merely starts the same', () => {
    expect(readRomaEnv({ ...MINIMAL, ROMA_AUDIT_ROOT: '/srv/roma/sessions-audit' }).auditRoot).toBe(
      '/srv/roma/sessions-audit',
    )
  })

  it.each([
    [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'defaulted, roma runs on the host’s own login rather than the Shared Window it was given',
    ],
    [
      'ROMA_AUDIT_ROOT',
      'defaulted under the working directories, the seven-day reclaim deletes the Audit Records, ' +
        'the only record of who spent what',
    ],
    [
      'ROMA_CLAUDE_CONFIG_DIR',
      'defaulted to Claude Code’s own, every Transcript lands in the host user’s ~/.claude, ' +
        'mixed with their own and never reclaimed (ADR-0005)',
    ],
  ])(
    'refuses %s on its own, rather than falling back [fence:env-no-fallback-for-what-cannot-be-lost]',
    (name, cost) => {
      const why = `${name} must be refused when it is missing, alone, with no fallback (#31): ${cost}.`
      const withoutIt: Record<string, string> = { ...MINIMAL }
      delete withoutIt[name]

      expect(() => readRomaEnv(withoutIt), why).toThrow(new RegExp(name))
    },
  )

  it.each([
    ['inside', '/srv/roma/sessions/audit'],
    ['deeper inside', '/srv/roma/sessions/a/b/audit'],
    ['that is', '/srv/roma/sessions/'],
    ['inside, by a relative step,', '/srv/roma/sessions/../sessions/audit'],
  ])(
    'refuses an audit root %s the work root [fence:env-audit-root-outside-the-work-root]',
    (_, auditRoot) => {
      const why =
        'ROMA_AUDIT_ROOT must be refused when it is under ROMA_WORK_ROOT (ADR-0002, #31). The ' +
        'work root is walked by a reclaim that deletes any directory nothing has touched for seven ' +
        'days, and appending to a month’s file does not touch its directory: the Audit Records — ' +
        'the only record of who spent what, which the provider cannot reconstruct — are deleted ' +
        'after a quiet week.'

      expect(() => readRomaEnv({ ...MINIMAL, ROMA_AUDIT_ROOT: auditRoot }), why).toThrow(
        /ROMA_AUDIT_ROOT/,
      )
    },
  )

  it('takes an audit root beside the work root, whose name merely starts the same', () => {
    expect(readRomaEnv({ ...MINIMAL, ROMA_AUDIT_ROOT: '/srv/roma/sessions-audit' }).auditRoot).toBe(
      '/srv/roma/sessions-audit',
    )
  })

  // An empty string is not a value. It is what a shell leaves behind when a
  // variable was meant to be set from something that turned out to be empty,
  // and taking it at face value would boot roma on an empty token — which the
  // self-check would then refuse in a way that names the credential rather than
  // the deployment mistake.
  it('treats an empty variable as an absent one', () => {
    expect(() => readRomaEnv({ ...MINIMAL, CLAUDE_CODE_OAUTH_TOKEN: '' })).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN/,
    )
  })

  describe('Overflow, which is off unless it is configured whole', () => {
    // ADR-0002 has it off by default, and this is what "default" means at the
    // boundary: no metered key in the environment, no Overflow anywhere in roma.
    it('is absent when no metered key is set', () => {
      expect(readRomaEnv(MINIMAL).overflow).toBeUndefined()
    })

    it('is the key and the cap together', () => {
      const { overflow } = readRomaEnv({
        ...MINIMAL,
        ROMA_OVERFLOW_API_KEY: 'metered-key',
        ROMA_OVERFLOW_MONTHLY_CAP_USD: '250',
      })

      expect(overflow).toEqual({
        credential: { kind: 'overflow', apiKey: 'metered-key' },
        monthlyCapUsd: 250,
      })
    })

    // A key with no cap is a credential with nothing bounding what it spends,
    // which is the one configuration ADR-0002 exists to prevent. Refused rather
    // than defaulted: how much of somebody's money roma may spend is not a
    // number roma gets to pick.
    it('refuses a metered key with no monthly cap [fence:env-overflow-whole-and-roma-own]', () => {
      expect(
        () => readRomaEnv({ ...MINIMAL, ROMA_OVERFLOW_API_KEY: 'metered-key' }),
        OVERFLOW,
      ).toThrow(/ROMA_OVERFLOW_MONTHLY_CAP_USD/)
    })

    it('refuses a cap that is not a positive number', () => {
      for (const cap of ['nought', '-5', '0', '']) {
        expect(() =>
          readRomaEnv({
            ...MINIMAL,
            ROMA_OVERFLOW_API_KEY: 'metered-key',
            ROMA_OVERFLOW_MONTHLY_CAP_USD: cap,
          }),
        ).toThrow(/ROMA_OVERFLOW_MONTHLY_CAP_USD/)
      }
    })

    // The other half of the pair, and the more dangerous way round: a cap on its
    // own caps nothing, and reading it as configured Overflow would have roma
    // offer a valve with no credential behind it — a button somebody presses
    // while they are already waiting, which then cannot work.
    it('refuses a cap with no metered key [fence:env-overflow-whole-and-roma-own]', () => {
      expect(
        () => readRomaEnv({ ...MINIMAL, ROMA_OVERFLOW_MONTHLY_CAP_USD: '250' }),
        OVERFLOW,
      ).toThrow(/ROMA_OVERFLOW_API_KEY/)
    })

    // Deliberately not `ANTHROPIC_API_KEY`. That name is set on developer
    // machines and in CI images for reasons that have nothing to do with roma,
    // and reading it here would turn metered billing on for a whole deployment
    // because somebody's shell profile mentioned it.
    it('ignores a stray ANTHROPIC_API_KEY in roma’s own environment [fence:env-overflow-whole-and-roma-own]', () => {
      expect(
        readRomaEnv({ ...MINIMAL, ANTHROPIC_API_KEY: 'somebody-elses' }).overflow,
        OVERFLOW,
      ).toBeUndefined()
    })
  })

  describe('the settings a deployment may override and usually does not', () => {
    it('passes through the model and the concurrency cap', () => {
      expect(
        readRomaEnv({
          ...MINIMAL,
          ROMA_MODEL: 'claude-sonnet-5',
          ROMA_EFFORT: 'max',
          ROMA_CAVEMAN: 'lite',
          ROMA_MAX_CONCURRENT_TASKS: '5',
        }),
      ).toMatchObject({
        model: 'claude-sonnet-5',
        effort: 'max',
        caveman: 'lite',
        maxConcurrentTasks: 5,
      })
    })

    // **The one wrong-effort failure that needs no measurement to catch, and the
    // only place it can be caught.** Claude Code will not refuse this: an
    // unrecognised `--effort` warns on stderr, the process starts, and it runs
    // on the build's own default — so a deployment that mistyped this would be
    // wrong about every Session it serves and every record it writes, and
    // nothing would stop (ADR-0016).
    it('refuses an effort the build would silently ignore [fence:env-effort-compared-exactly]', () => {
      const why =
        'ROMA_EFFORT must be validated here, exactly — never passed through, folded or trimmed ' +
        '(ADR-0016, #110). Claude Code will not refuse it: an unrecognised --effort warns on ' +
        'stderr and runs on the build’s own default, so a mistyped value is wrong about every ' +
        'Session and every Audit Record with nothing stopping. A repaired spelling is roma ' +
        'guessing at a value whose whole purpose is to be the one somebody decided.'
      for (const effort of ['bananas', 'auto', 'HIGH', 'default', ' high', 'high\n']) {
        expect(() => readRomaEnv({ ...MINIMAL, ROMA_EFFORT: effort }), why).toThrow(/ROMA_EFFORT/)
      }
    })

    // Accepted here and only here. It is not a level — it is `xhigh` plus
    // dynamic workflow orchestration — so it is off the Effort Menu and no
    // Caller may reach it. An operator may pin it, for the reason `ROMA_MODEL`
    // may already name a model off the Model Menu: the Menu bounds Callers and
    // never the operator.
    it('takes ultracode from an operator, which no Caller can ask for', () => {
      expect(readRomaEnv({ ...MINIMAL, ROMA_EFFORT: 'ultracode' })).toMatchObject({
        effort: 'ultracode',
      })
    })

    // **Refused here because nothing downstream would ever see it.** A mistyped
    // effort at least reaches Claude Code, which warns about it on stderr; a
    // mistyped Caveman is roma's own word for text roma assembles itself, so
    // there is no process anywhere that could disagree with it — unrefused, it
    // would append a ruleset whose intensity table had no rows (ADR-0030).
    it('refuses a Caveman roma has no ruleset for [fence:env-caveman-compared-exactly]', () => {
      for (const caveman of ['bananas', 'FULL', 'default', 'commit', ' lite']) {
        expect(() => readRomaEnv({ ...MINIMAL, ROMA_CAVEMAN: caveman }), CAVEMAN).toThrow(
          /ROMA_CAVEMAN/,
        )
      }
    })

    // A refusal an operator can act on without opening the README. Written out
    // here rather than joined from the constants, so that a list quietly losing a
    // level fails instead of agreeing with itself.
    it('names every level it would have taken instead', () => {
      expect(() => readRomaEnv({ ...MINIMAL, ROMA_CAVEMAN: 'bananas' })).toThrow(
        /Set one of: off, lite, full, ultra, wenyan-full — or wenyan-lite, wenyan-ultra/,
      )
    })

    // The alias caveman's own hook rewrites to `wenyan-full`. roma relays nothing
    // to that hook, so accepting it would be a second spelling roma had chosen to
    // claim for a level it already has one for — `ROMA_EFFORT`'s refusal of `med`,
    // and the refusal names the spelling roma does take.
    it('refuses wenyan, and says which spelling of it roma pins [fence:env-caveman-compared-exactly]', () => {
      expect(() => readRomaEnv({ ...MINIMAL, ROMA_CAVEMAN: 'wenyan' }), CAVEMAN).toThrow(
        /ROMA_CAVEMAN is "wenyan".*wenyan-full/s,
      )
    })

    // All seven at the variable an operator actually sets, rather than at the
    // function behind it — this is the whole of ADR-0030's operator half, and a
    // level that could not be set would be a level roma does not have. The last
    // two are the Caveman Menu's `ultracode`: held back from a Caller because
    // wenyan's own row claims its saving in characters and roma is spent in
    // tokens, and reachable by an operator all the same, because the Menu bounds
    // Callers and never the operator.
    it('takes every level an operator may pin, the two no Caller may ask for included', () => {
      for (const caveman of [...CAVEMAN_MENU, ...OFF_MENU_WENYAN]) {
        expect(readRomaEnv({ ...MINIMAL, ROMA_CAVEMAN: caveman })).toMatchObject({ caveman })
      }
      for (const caveman of OFF_MENU_WENYAN) expect(CAVEMAN_MENU).not.toContain(caveman)
    })

    // Optional, which is the opposite of what the Overflow cap is, and the
    // difference is what each authorises: the cap opens a *new* way to spend
    // money and effort is money already being spent under another name.
    // Requiring it would stop every existing deployment booting in exchange for
    // a signature on a default they already pay for.
    it('does not insist on one, unlike the Overflow cap', () => {
      expect(() => readRomaEnv(MINIMAL)).not.toThrow()
    })

    // Absent rather than present-and-undefined, so that `startRoma` sees the
    // same thing a caller who never mentioned them would produce and its own
    // defaults apply.
    it('leaves them out entirely when they are not set [fence:env-unset-settings-are-absent]', () => {
      const why =
        'An optional setting the environment does not name must be absent from what readRomaEnv ' +
        'returns, not present and undefined (#31): startRoma has its own default for every one, ' +
        'and must see what a caller who never mentioned them would produce. ' +
        '`exactOptionalPropertyTypes` holds the same rule at compile time.'
      expect(Object.keys(readRomaEnv(MINIMAL)).sort(), why).toEqual([
        'auditRoot',
        'configDir',
        'credential',
        'shimDir',
        'workRoot',
      ])
    })

    it('refuses a concurrency cap that is not a positive whole number', () => {
      for (const cap of ['three', '0', '-1', '2.5']) {
        expect(() => readRomaEnv({ ...MINIMAL, ROMA_MAX_CONCURRENT_TASKS: cap })).toThrow(
          /ROMA_MAX_CONCURRENT_TASKS/,
        )
      }
    })
  })
})

describe('the Core, its Channels and its Minter, read as one configuration', () => {
  /**
   * A Channel with two variables, one of them required.
   *
   * Two rather than one so that "named none of them" and "named half of them"
   * are different answers, which is the whole of what makes a Channel optional:
   * the first is a deployment serving somebody else's Channel and the second is
   * one that meant to serve this one (ADR-0028).
   */
  const readChannel = (prefix: string) => (env: Parameters<typeof readRomaEnv>[0]) => {
    const thing = env[`${prefix}_THING`]
    const spare = env[`${prefix}_SPARE`]
    if (thing === undefined && spare === undefined) return null
    if (thing === undefined) throw new ConfigurationMissing([`${prefix}_THING is not set.`])
    return { thing, spare: spare ?? 'a default' }
  }

  const readMinter = (env: Parameters<typeof readRomaEnv>[0]) => {
    if (env['MINTER_THING'] === undefined)
      throw new ConfigurationMissing(['MINTER_THING is not set.'])
    return { thing: env['MINTER_THING'] }
  }

  const readCloud = (env: Parameters<typeof readRomaEnv>[0]) => {
    const thing = env['CLOUD_THING']
    if (thing === 'broken') throw new ConfigurationMissing(['CLOUD_THING is nonsense.'])
    // Most deployments have no Cloud Reach, and nothing is wrong with that.
    return thing === undefined ? null : { thing }
  }

  const readDocument = (env: Parameters<typeof readRomaEnv>[0]) => {
    const thing = env['DOCUMENT_THING']
    if (thing === 'broken') throw new ConfigurationMissing(['DOCUMENT_THING is nonsense.'])
    // Most deployments have no Document Reach either.
    return thing === undefined ? null : { thing }
  }

  const CHANNELS = { first: readChannel('FIRST'), second: readChannel('SECOND') }

  it('hands back all five parts', () => {
    const { roma, channels, minterEnv, cloudEnv, documentEnv } = readConfiguration(
      {
        ...MINIMAL,
        FIRST_THING: 'yes',
        MINTER_THING: 'also yes',
        CLOUD_THING: 'and yes',
        DOCUMENT_THING: 'yes again',
      },
      CHANNELS,
      readMinter,
      readCloud,
      readDocument,
    )

    expect(roma.workRoot).toBe('/srv/roma/sessions')
    expect(channels.first).toEqual({ thing: 'yes', spare: 'a default' })
    expect(minterEnv).toEqual({ thing: 'also yes' })
    expect(cloudEnv).toEqual({ thing: 'and yes' })
    expect(documentEnv).toEqual({ thing: 'yes again' })
  })

  // The two parts that may legitimately find nothing. A deployment with neither
  // optional Reach is not half-configured, so this is not the Overflow shape.
  it('starts perfectly well with nothing to say about the cloud or the documents', () => {
    const { cloudEnv, documentEnv } = readConfiguration(
      { ...MINIMAL, FIRST_THING: 'yes', MINTER_THING: 'also yes' },
      CHANNELS,
      readMinter,
      readCloud,
      readDocument,
    )

    expect(cloudEnv).toBeNull()
    expect(documentEnv).toBeNull()
  })

  // The whole of what a second Channel costs a deployment that does not want
  // one: nothing. Naming the other Channel's variables is not a condition of
  // serving this one (ADR-0028).
  it('serves one Channel without the other being configured at all', () => {
    const { channels } = readConfiguration(
      { ...MINIMAL, SECOND_THING: 'yes', MINTER_THING: 'also yes' },
      CHANNELS,
      readMinter,
      readCloud,
      readDocument,
    )

    expect(channels.first).toBeNull()
    expect(channels.second).toMatchObject({ thing: 'yes' })
  })

  // The one deployment that is complete in every part and still cannot work: it
  // would boot, prove its credential, subscribe to nothing and answer nobody,
  // which is the failure that has no symptom anywhere else.
  it('refuses a deployment that configured no Channel at all', () => {
    expect(() =>
      readConfiguration(
        { ...MINIMAL, MINTER_THING: 'yes' },
        CHANNELS,
        readMinter,
        readCloud,
        readDocument,
      ),
    ).toThrow(/at least one of: first, second/)
  })

  // Half a Channel is a deployment that plainly meant to serve it, so it is
  // refused naming what is missing — never read as a deployment that wanted a
  // different Channel. It is also not told it configured no Channel: it did, and
  // sending it to the other one would be advice about something it never asked
  // for.
  it('refuses a Channel configured by halves rather than answering nobody on it [fence:env-a-refused-channel-is-not-sent-elsewhere]', () => {
    const why =
      'A Channel that refused must be the only thing its deployment is told about: "No Channel ' +
      'is configured" belongs only where every Channel was silent. A deployment that configured ' +
      'half of one plainly meant to serve it, and telling it to configure another sends it to a ' +
      'Channel it never wanted (ADR-0028).'
    try {
      readConfiguration(
        { ...MINIMAL, FIRST_SPARE: 'set', MINTER_THING: 'yes' },
        CHANNELS,
        readMinter,
        readCloud,
        readDocument,
      )
      expect.unreachable('should have refused')
    } catch (error) {
      expect((error as ConfigurationMissing).problems, why).toEqual(['FIRST_THING is not set.'])
    }
  })

  // `certain` stands where a non-null cast would otherwise go. Its invariant —
  // no problems means every part was found — is one the types cannot see, so it
  // is broken here on purpose: a reader that found nothing and said nothing.
  it('refuses to hand back a part it never found [fence:env-certain-not-a-cast]', () => {
    const why =
      'readConfiguration must check, not cast, that each part it hands back was found: the ' +
      'invariant that an empty problem list means every required part is present is one the ' +
      'types cannot see, and a later edit that broke it would otherwise boot roma on an ' +
      'undefined configuration with nothing said (#31).'
    expect(
      () =>
        readConfiguration(
          { ...MINIMAL, FIRST_THING: 'yes' },
          CHANNELS,
          () => null,
          readCloud,
          readDocument,
        ),
      why,
    ).toThrow(/read as complete while a part was missing/)
  })

  // Somebody standing roma up sets all of it in one go. Told about the Channel's
  // missing variable only after fixing the Core's, they boot twice to learn two
  // things they could have been told at once.
  it('refuses once, with what is wrong with any of them', () => {
    try {
      readConfiguration(
        { FIRST_SPARE: 'set', CLOUD_THING: 'broken', DOCUMENT_THING: 'broken' },
        CHANNELS,
        readMinter,
        readCloud,
        readDocument,
      )
      expect.unreachable('should have refused')
    } catch (error) {
      expect((error as ConfigurationMissing).problems).toEqual([
        'CLAUDE_CODE_OAUTH_TOKEN is not set.',
        'ROMA_WORK_ROOT is not set.',
        'ROMA_AUDIT_ROOT is not set.',
        'ROMA_CLAUDE_CONFIG_DIR is not set.',
        'ROMA_SHIM_DIR is not set.',
        'FIRST_THING is not set.',
        'MINTER_THING is not set.',
        'CLOUD_THING is nonsense.',
        'DOCUMENT_THING is nonsense.',
      ])
    }
  })

  // A reader that is broken is not an environment that is incomplete, and
  // reporting one as the other would send somebody looking for a variable that
  // was never the problem.
  it('lets anything that is not a configuration problem through [fence:env-a-broken-reader-is-not-a-missing-variable]', () => {
    const why =
      'Only ConfigurationMissing may be collected into the refusal; any other error from a ' +
      'reader must escape unchanged. A reader that is broken is not an environment that is ' +
      'incomplete, and reporting it as one sends somebody looking for a variable that was never ' +
      'the problem (#31).'
    expect(
      () =>
        readConfiguration(
          MINIMAL,
          {
            first: () => {
              throw new TypeError('the reader is broken')
            },
          },
          readMinter,
          readCloud,
          readDocument,
        ),
      why,
    ).toThrow(new TypeError('the reader is broken'))
  })
})

/**
 * Every real Channel reader, held to `ReadChannelEnv`'s two answers.
 *
 * Which variables a reader reads is discovered by watching it read, rather than
 * copied from its list: the list is exactly what could be narrowed.
 */
describe('a real Channel, named at all', () => {
  const READERS = { chat: readChatEnv, discord: readDiscordEnv }

  /** Every variable `read` looks at, whether the environment has it or not. */
  function variablesReadBy(read: (env: Environment) => unknown): string[] {
    const seen = new Set<string>()
    const watching = (answer: (name: string) => string | undefined) =>
      new Proxy({} as Environment, {
        get: (_, name) => {
          if (typeof name === 'string') seen.add(name)
          return typeof name === 'string' ? answer(name) : undefined
        },
      })
    try {
      read(watching(() => undefined))
    } catch {
      // A refusal is an answer; what was read on the way to it is all this wants.
    }
    try {
      read(watching(() => '1'))
    } catch {
      // As above.
    }
    return [...seen].sort()
  }

  it.each(Object.entries(READERS))(
    '%s is served or refused on any one of its variables, never ignored [fence:env-a-channel-named-is-served-or-refused]',
    (_, read) => {
      const why = (name: string) =>
        `A deployment that set ${name} and nothing else of this Channel must be served or ` +
        'refused, never read as one with no such Channel (ADR-0028). Every variable a Channel ' +
        'reads, optional ones included, has to go into `unconfigured`: narrowed to the required ' +
        'ones, somebody who set a lease or a proxy address and forgot the credential gets a roma ' +
        'that starts, answers nobody on that Channel, and ignores the variable they did set.'
      const names = variablesReadBy(read)
      expect(names.length).toBeGreaterThan(1)

      for (const name of names) {
        let answer: unknown
        try {
          answer = read({ [name]: '1' })
        } catch (error) {
          expect(error, why(name)).toBeInstanceOf(ConfigurationMissing)
          continue
        }
        expect(answer, why(name)).not.toBeNull()
      }
    },
  )
})
