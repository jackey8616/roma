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

  // Nothing rather than a refusal, and that is the whole of what makes this
  // Channel optional: a deployment that named none of these serves another
  // Channel, and requiring Chat's variables of it would be roma insisting on a
  // subscription for a product nobody there uses (ADR-0028).
  it('finds nothing where the deployment said nothing about Chat', () => {
    expect(readChatEnv({})).toBeNull()
  })

  // Half of it is the other answer, and the dangerous one. Somebody who set one
  // of these meant to serve Chat, and a roma that read that as silence would
  // start, subscribe to nothing, and ignore the variable they did set.
  it('names both required variables where the deployment named part of a Chat', () => {
    for (const named of ['ROMA_PUBSUB_MAX_MESSAGES', 'ROMA_PUBSUB_MAX_LEASE_MINUTES']) {
      expect(() => readChatEnv({ [named]: '5' }), named).toThrow(ConfigurationMissing)

      try {
        readChatEnv({ [named]: '5' })
      } catch (error) {
        const problems = (error as ConfigurationMissing).problems.join('\n')
        expect(problems, named).toContain('ROMA_PUBSUB_PROJECT_ID')
        expect(problems, named).toContain('ROMA_PUBSUB_SUBSCRIPTION')
      }
    }
  })

  it('names the one that is missing where the deployment named the other', () => {
    expect(() => readChatEnv({ ROMA_PUBSUB_PROJECT_ID: 'roma-prod' })).toThrow(
      /ROMA_PUBSUB_SUBSCRIPTION/,
    )
    expect(() => readChatEnv({ ROMA_PUBSUB_SUBSCRIPTION: 'roma-chat-events' })).toThrow(
      /ROMA_PUBSUB_PROJECT_ID/,
    )
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
