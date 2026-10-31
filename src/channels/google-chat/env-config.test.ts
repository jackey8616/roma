import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../../config.js'
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

  it('finds nothing where the deployment said nothing about Chat', () => {
    expect(readChatEnv({})).toBeNull()
  })

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

    it('leaves a /stop room to arrive past every Task that can be in flight [fence:gchat-flow-control-above-the-cap]', () => {
      const why =
        'Pub/Sub flow control must sit well above the concurrency cap (ADR-0003). A Command ' +
        'is answered outside the Task Queue so that `/stop` never waits behind the Task it ' +
        'stops, but a message Pub/Sub holds back has not reached the Core to be read as a ' +
        'Command at all. With every slot running and as many again queued, each holding a ' +
        'lease, a limit near the cap reinstates exactly that wait (#31).'

      expect(DEFAULT_MAX_MESSAGES, why).toBeGreaterThan(2 * defaultConfig.maxConcurrentTasks)
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
