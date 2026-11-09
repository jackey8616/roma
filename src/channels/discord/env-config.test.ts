import { describe, expect, it } from 'vitest'
import { ConfigurationMissing } from '../../env-config.js'
import { DEFAULT_API_BASE, DEFAULT_GATEWAY_URL, readDiscordEnv } from './env-config.js'

const MINIMAL = { ROMA_DISCORD_BOT_TOKEN: 'a-bot-token' }

describe('reading the Discord channel out of the environment', () => {
  it('reads the token roma identifies with', () => {
    expect(readDiscordEnv(MINIMAL)).toMatchObject({ botToken: 'a-bot-token' })
  })

  it('finds nothing where the deployment said nothing about Discord', () => {
    expect(readDiscordEnv({})).toBeNull()
  })

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

  it('needs no address, because both have one', () => {
    expect(readDiscordEnv(MINIMAL)).toMatchObject({
      gatewayUrl: DEFAULT_GATEWAY_URL,
      apiBase: DEFAULT_API_BASE,
    })
  })

  it('speaks one version of the API on both of them [fence:discord-one-api-version]', () => {
    const why =
      'The Gateway URL and the REST base must name one API version (ADR-0029). On two, roma ' +
      'reads one shape and asks for another, and that fails inside a payload rather than at ' +
      'boot (#191).'
    const version = /\bv=?(\d+)/.exec(DEFAULT_GATEWAY_URL)?.[1]

    expect(version).toBeDefined()
    expect(DEFAULT_API_BASE, why).toContain(`/v${version ?? ''}`)
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
