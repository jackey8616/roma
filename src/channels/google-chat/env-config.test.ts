import { describe, expect, it } from 'vitest'
import { ConfigurationMissing } from '../../env-config.js'
import { DEFAULT_MAX_LEASE_MINUTES, DEFAULT_MAX_MESSAGES, readChatEnv } from './env-config.js'

const MINIMAL = {
  ROMA_PUBSUB_PROJECT_ID: 'roma-prod',
  ROMA_PUBSUB_SUBSCRIPTION: 'roma-chat-events',
}

describe('reading the Chat channel out of the environment', () => {
  it('reads the project and the subscription roma pulls from', () => {
    expect(readChatEnv(MINIMAL)).toMatchObject({
      projectId: 'roma-prod',
      subscription: 'roma-chat-events',
    })
  })

  it('names both when neither is set', () => {
    expect(() => readChatEnv({})).toThrow(ConfigurationMissing)

    try {
      readChatEnv({})
    } catch (error) {
      expect((error as ConfigurationMissing).problems.join('\n')).toContain(
        'ROMA_PUBSUB_PROJECT_ID',
      )
      expect((error as ConfigurationMissing).problems.join('\n')).toContain(
        'ROMA_PUBSUB_SUBSCRIPTION',
      )
    }
  })

  // The subscription is a name roma reads, never one it creates. A deployment
  // that has not made one yet is a deployment that cannot start, and saying so
  // is better than roma quietly making one nothing is publishing to.
  it('takes the subscription as a name rather than a path to create', () => {
    expect(readChatEnv({ ...MINIMAL, ROMA_PUBSUB_SUBSCRIPTION: 'roma-chat-events' })).toMatchObject(
      { subscription: 'roma-chat-events' },
    )
  })

  describe('how much of the subscription roma holds at once', () => {
    it('has defaults, so a deployment need decide neither', () => {
      expect(readChatEnv(MINIMAL)).toMatchObject({
        maxMessages: DEFAULT_MAX_MESSAGES,
        maxLeaseMinutes: DEFAULT_MAX_LEASE_MINUTES,
      })
    })

    it('lets a deployment set both', () => {
      expect(
        readChatEnv({
          ...MINIMAL,
          ROMA_PUBSUB_MAX_MESSAGES: '5',
          ROMA_PUBSUB_MAX_LEASE_MINUTES: '120',
        }),
      ).toMatchObject({ maxMessages: 5, maxLeaseMinutes: 120 })
    })

    it('refuses either as anything but a positive whole number', () => {
      for (const name of ['ROMA_PUBSUB_MAX_MESSAGES', 'ROMA_PUBSUB_MAX_LEASE_MINUTES']) {
        for (const value of ['lots', '0', '-3', '1.5']) {
          expect(() => readChatEnv({ ...MINIMAL, [name]: value })).toThrow(new RegExp(name))
        }
      }
    })
  })
})
