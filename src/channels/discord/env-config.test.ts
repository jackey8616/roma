import { describe, expect, it } from 'vitest'
import { ConfigurationMissing } from '../../env-config.js'
import { DEFAULT_API_BASE, DEFAULT_GATEWAY_URL, readDiscordEnv } from './env-config.js'

const MINIMAL = { ROMA_DISCORD_BOT_TOKEN: 'a-bot-token' }

describe('reading the Discord channel out of the environment', () => {
  it('reads the token roma identifies with', () => {
    expect(readDiscordEnv(MINIMAL)).toMatchObject({ botToken: 'a-bot-token' })
  })

  // Nothing rather than a refusal, and that is the whole of what makes this
  // Channel optional: a deployment that named none of these serves another
  // Channel, and requiring a bot token of it would be roma insisting on an
  // application nobody there has made (ADR-0028).
  it('finds nothing where the deployment said nothing about Discord', () => {
    expect(readDiscordEnv({})).toBeNull()
  })

  // Half of it is the other answer, and the dangerous one. Somebody who pointed
  // the API at a proxy meant to serve Discord, and a roma that read that as
  // silence would start, connect to nothing, and ignore the variable they set.
  it('refuses a Discord configured by halves, naming what is missing', () => {
    for (const named of ['ROMA_DISCORD_GATEWAY_URL', 'ROMA_DISCORD_API_BASE']) {
      expect(() => readDiscordEnv({ [named]: 'wss://somewhere' }), named).toThrow(
        ConfigurationMissing,
      )
      expect(() => readDiscordEnv({ [named]: 'wss://somewhere' }), named).toThrow(
        /ROMA_DISCORD_BOT_TOKEN/,
      )
    }
  })

  // Neither is a deployment's to know: they are Discord's own addresses, the
  // same everywhere, and a deployment made to state them is one that can state
  // them wrong.
  it('needs no address, because both have one', () => {
    expect(readDiscordEnv(MINIMAL)).toMatchObject({
      gatewayUrl: DEFAULT_GATEWAY_URL,
      apiBase: DEFAULT_API_BASE,
    })
  })

  // One version, in both places. A Gateway on one and a REST call on another is
  // roma reading one shape and asking for a different one, and that failure
  // arrives in a payload rather than at boot.
  it('speaks one version of the API on both of them', () => {
    const version = /\bv=?(\d+)/.exec(DEFAULT_GATEWAY_URL)?.[1]

    expect(version).toBeDefined()
    expect(DEFAULT_API_BASE).toContain(`/v${version ?? ''}`)
  })

  it('lets a deployment point either one somewhere else', () => {
    expect(
      readDiscordEnv({
        ...MINIMAL,
        ROMA_DISCORD_GATEWAY_URL: 'wss://gateway.internal/?v=10&encoding=json',
        ROMA_DISCORD_API_BASE: 'https://discord.internal/api/v10',
      }),
    ).toMatchObject({
      gatewayUrl: 'wss://gateway.internal/?v=10&encoding=json',
      apiBase: 'https://discord.internal/api/v10',
    })
  })
})
