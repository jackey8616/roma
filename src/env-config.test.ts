import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
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

  it('treats an empty variable as an absent one [fence:env-empty-is-unset]', () => {
    const why =
      'envValue must answer null for an empty string, as for an unset variable (#31): ' +
      'taken as a value it boots roma on an empty token, which then fails as a credential ' +
      'problem rather than as the deployment mistake it is.'
    expect(() => readRomaEnv({ ...MINIMAL, CLAUDE_CODE_OAUTH_TOKEN: '' }), why).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN/,
    )
  })

  describe('Overflow, which is off unless it is configured whole', () => {
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

    it('refuses a cap with no metered key [fence:env-overflow-whole-and-roma-own]', () => {
      expect(
        () => readRomaEnv({ ...MINIMAL, ROMA_OVERFLOW_MONTHLY_CAP_USD: '250' }),
        OVERFLOW,
      ).toThrow(/ROMA_OVERFLOW_API_KEY/)
    })

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

    it('takes ultracode from an operator, which no Caller can ask for', () => {
      expect(readRomaEnv({ ...MINIMAL, ROMA_EFFORT: 'ultracode' })).toMatchObject({
        effort: 'ultracode',
      })
    })

    it('refuses a Caveman roma has no ruleset for [fence:env-caveman-compared-exactly]', () => {
      for (const caveman of ['bananas', 'FULL', 'default', 'commit', ' lite']) {
        expect(() => readRomaEnv({ ...MINIMAL, ROMA_CAVEMAN: caveman }), CAVEMAN).toThrow(
          /ROMA_CAVEMAN/,
        )
      }
    })

    it('names every level it would have taken instead', () => {
      expect(() => readRomaEnv({ ...MINIMAL, ROMA_CAVEMAN: 'bananas' })).toThrow(
        /Set one of: off, lite, full, ultra, wenyan-full — or wenyan-lite, wenyan-ultra/,
      )
    })

    it('refuses wenyan, and says which spelling of it roma pins [fence:env-caveman-compared-exactly]', () => {
      expect(() => readRomaEnv({ ...MINIMAL, ROMA_CAVEMAN: 'wenyan' }), CAVEMAN).toThrow(
        /ROMA_CAVEMAN is "wenyan".*wenyan-full/s,
      )
    })

    it('takes every level an operator may pin, the two no Caller may ask for included', () => {
      for (const caveman of [...CAVEMAN_MENU, ...OFF_MENU_WENYAN]) {
        expect(readRomaEnv({ ...MINIMAL, ROMA_CAVEMAN: caveman })).toMatchObject({ caveman })
      }
      for (const caveman of OFF_MENU_WENYAN) expect(CAVEMAN_MENU).not.toContain(caveman)
    })

    it('does not insist on one, unlike the Overflow cap', () => {
      expect(() => readRomaEnv(MINIMAL)).not.toThrow()
    })

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
    return thing === undefined ? null : { thing }
  }

  const readDocument = (env: Parameters<typeof readRomaEnv>[0]) => {
    const thing = env['DOCUMENT_THING']
    if (thing === 'broken') throw new ConfigurationMissing(['DOCUMENT_THING is nonsense.'])
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

describe('a real Channel, named at all', () => {
  const READERS = { chat: readChatEnv, discord: readDiscordEnv }

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
    } catch {}
    try {
      read(watching(() => '1'))
    } catch {}
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

describe('every reader of the environment', () => {
  it('reads a variable through envValue and never by indexing [fence:env-read-through-env-value]', () => {
    const why =
      'envValue is the one place that decides whether the environment really has a variable, ' +
      'and the rule a second copy would drop first is the one that is not obvious: an empty ' +
      'string is unset. Every env-config.ts, the Channels’ and the Reaches’ included, reads ' +
      'through it rather than indexing the environment itself.'
    const src = fileURLToPath(new URL('.', import.meta.url))
    const indexing = globSync('**/env-config.ts', { cwd: src }).flatMap((file) => {
      const source = ts.createSourceFile(
        file,
        readFileSync(src + file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      )
      const found: string[] = []
      const visit = (node: ts.Node): void => {
        const read =
          (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) &&
          ['env', 'process.env'].includes(node.expression.getText(source))
        if (read && !(file === 'env-config.ts' && enclosingFunction(node) === 'envValue')) {
          found.push(`${file}: ${node.getText(source)}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      return found
    })

    expect(indexing, why).toEqual([])
  })
})

function enclosingFunction(node: ts.Node): string | undefined {
  for (let at: ts.Node | undefined = node; at !== undefined; at = at.parent) {
    if (ts.isFunctionDeclaration(at)) return at.name?.text
  }
  return undefined
}
