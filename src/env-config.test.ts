import { describe, expect, it } from 'vitest'
import { ConfigurationMissing, readConfiguration, readRomaEnv } from './env-config.js'

/** Everything roma insists on, and nothing it does not. */
const MINIMAL = {
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
  ROMA_WORK_ROOT: '/srv/roma/sessions',
  ROMA_AUDIT_ROOT: '/var/lib/roma/audit',
  ROMA_CLAUDE_CONFIG_DIR: '/srv/roma/claude',
  ROMA_SHIM_DIR: '/run/roma',
}

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
    it('refuses a metered key with no monthly cap', () => {
      expect(() => readRomaEnv({ ...MINIMAL, ROMA_OVERFLOW_API_KEY: 'metered-key' })).toThrow(
        /ROMA_OVERFLOW_MONTHLY_CAP_USD/,
      )
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
    it('refuses a cap with no metered key', () => {
      expect(() => readRomaEnv({ ...MINIMAL, ROMA_OVERFLOW_MONTHLY_CAP_USD: '250' })).toThrow(
        /ROMA_OVERFLOW_API_KEY/,
      )
    })

    // Deliberately not `ANTHROPIC_API_KEY`. That name is set on developer
    // machines and in CI images for reasons that have nothing to do with roma,
    // and reading it here would turn metered billing on for a whole deployment
    // because somebody's shell profile mentioned it.
    it('ignores a stray ANTHROPIC_API_KEY in roma’s own environment', () => {
      expect(
        readRomaEnv({ ...MINIMAL, ANTHROPIC_API_KEY: 'somebody-elses' }).overflow,
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
          ROMA_MAX_CONCURRENT_TASKS: '5',
        }),
      ).toMatchObject({
        model: 'claude-sonnet-5',
        effort: 'max',
        maxConcurrentTasks: 5,
      })
    })

    // **The one wrong-effort failure that needs no measurement to catch, and the
    // only place it can be caught.** Claude Code will not refuse this: an
    // unrecognised `--effort` warns on stderr, the process starts, and it runs
    // on the build's own default — so a deployment that mistyped this would be
    // wrong about every Session it serves and every record it writes, and
    // nothing would stop (ADR-0016).
    it('refuses an effort the build would silently ignore', () => {
      for (const effort of ['bananas', 'auto', 'HIGH', 'default']) {
        expect(() => readRomaEnv({ ...MINIMAL, ROMA_EFFORT: effort })).toThrow(/ROMA_EFFORT/)
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
    it('leaves them out entirely when they are not set', () => {
      expect(Object.keys(readRomaEnv(MINIMAL)).sort()).toEqual([
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
  it('refuses a Channel configured by halves rather than answering nobody on it', () => {
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
      expect((error as ConfigurationMissing).problems).toEqual(['FIRST_THING is not set.'])
    }
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
  it('lets anything that is not a configuration problem through', () => {
    expect(() =>
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
    ).toThrow(TypeError)
  })
})
