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
      socketDir: '/run/roma',
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
      expect(readRomaEnv({ ...MINIMAL, ANTHROPIC_API_KEY: 'somebody-elses' }).overflow).toBeUndefined()
    })
  })

  describe('the settings a deployment may override and usually does not', () => {
    it('passes through the model and the concurrency cap', () => {
      expect(
        readRomaEnv({
          ...MINIMAL,
          ROMA_MODEL: 'claude-sonnet-5',
          ROMA_MAX_CONCURRENT_TASKS: '5',
        }),
      ).toMatchObject({
        model: 'claude-sonnet-5',
        maxConcurrentTasks: 5,
      })
    })

    // Absent rather than present-and-undefined, so that `startRoma` sees the
    // same thing a caller who never mentioned them would produce and its own
    // defaults apply.
    it('leaves them out entirely when they are not set', () => {
      expect(Object.keys(readRomaEnv(MINIMAL)).sort()).toEqual([
        'auditRoot',
        'configDir',
        'credential',
        'socketDir',
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

describe('the Core, its Channel and its Minter, read as one configuration', () => {
  const readChannel = (env: Parameters<typeof readRomaEnv>[0]) => {
    if (env['CHANNEL_THING'] === undefined) throw new ConfigurationMissing(['CHANNEL_THING is not set.'])
    return { thing: env['CHANNEL_THING'] }
  }

  const readMinter = (env: Parameters<typeof readRomaEnv>[0]) => {
    if (env['MINTER_THING'] === undefined) throw new ConfigurationMissing(['MINTER_THING is not set.'])
    return { thing: env['MINTER_THING'] }
  }

  it('hands back all three parts', () => {
    const { roma, channelEnv, minterEnv } = readConfiguration(
      { ...MINIMAL, CHANNEL_THING: 'yes', MINTER_THING: 'also yes' },
      readChannel,
      readMinter,
    )

    expect(roma.workRoot).toBe('/srv/roma/sessions')
    expect(channelEnv).toEqual({ thing: 'yes' })
    expect(minterEnv).toEqual({ thing: 'also yes' })
  })

  // Somebody standing roma up sets all of it in one go. Told about the Channel's
  // missing variable only after fixing the Core's, they boot twice to learn two
  // things they could have been told at once.
  it('refuses once, with what is wrong with any of them', () => {
    try {
      readConfiguration({}, readChannel, readMinter)
      expect.unreachable('should have refused')
    } catch (error) {
      expect((error as ConfigurationMissing).problems).toEqual([
        'CLAUDE_CODE_OAUTH_TOKEN is not set.',
        'ROMA_WORK_ROOT is not set.',
        'ROMA_AUDIT_ROOT is not set.',
        'ROMA_CLAUDE_CONFIG_DIR is not set.',
        'ROMA_SHIM_DIR is not set.',
        'CHANNEL_THING is not set.',
        'MINTER_THING is not set.',
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
        () => {
          throw new TypeError('the reader is broken')
        },
        readMinter,
      ),
    ).toThrow(TypeError)
  })
})
