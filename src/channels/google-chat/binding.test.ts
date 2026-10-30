import { describe, expect, it, vi } from 'vitest'
import type { HttpChatApiOptions } from './http-chat-api.js'
import { googleChatBinding } from './binding.js'

const seen = vi.hoisted(() => ({
  requests: [] as Record<string, unknown>[],
  subscriptionOptions: [] as Record<string, unknown>[],
  apis: [] as HttpChatApiOptions[],
}))

// What gaxios does: JSON unless asked for something else, so a file read
// without `responseType` arrives as whatever its bytes parse or decode to.
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getClient() {
      return {
        request: async (options: Record<string, unknown>) => {
          seen.requests.push(options)
          const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47)
          return { data: options.responseType === 'arraybuffer' ? png.buffer : '�PNG' }
        },
      }
    }
  },
}))

vi.mock('@google-cloud/pubsub', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google-cloud/pubsub')>()),
  PubSub: class {
    subscription(_name: string, options: Record<string, unknown>) {
      seen.subscriptionOptions.push(options)
      return { on: () => undefined, close: async () => undefined }
    }
  },
}))

vi.mock('./http-chat-api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./http-chat-api.js')>()
  return {
    ...real,
    HttpChatApi: class extends real.HttpChatApi {
      constructor(options: HttpChatApiOptions) {
        super(options)
        seen.apis.push(options)
      }
    },
  }
})

const CHAT = { projectId: 'p', subscription: 's', maxMessages: 20, maxLeaseMinutes: 60 }

describe('the Chat binding', () => {
  it('reads an attachment as bytes rather than as JSON [fence:gchat-download-is-bytes]', async () => {
    const why =
      'An Enclosure is downloaded with responseType arraybuffer (ADR-0011). Left to the ' +
      "library's default the file is parsed as JSON, so a PNG lands on disk as a throw at " +
      'best and a mangled string at worst (82cc769, #92).'
    await googleChatBinding(CHAT, () => undefined)
    const { download } = seen.apis.at(-1)!

    const bytes = await download('https://chat.googleapis.com/v1/media/a?alt=media')

    expect(seen.requests.at(-1), why).toMatchObject({ responseType: 'arraybuffer' })
    expect([...bytes], why).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('holds a message for as long as the deployment says, not the library default [fence:gchat-lease-is-set]', async () => {
    const why =
      'The subscription must set maxExtensionTime from ROMA_PUBSUB_MAX_LEASE_MINUTES ' +
      '(ADR-0028). roma holds a message for the whole of a Task, which is minutes; the ' +
      'library default gives up on one mid-Turn and has it delivered again alongside the ' +
      'run still going (a7044c8, #31).'
    await googleChatBinding({ ...CHAT, maxLeaseMinutes: 45 }, () => undefined)

    const extension = seen.subscriptionOptions.at(-1)?.maxExtensionTime as
      { totalOf(unit: 'minute'): number } | undefined

    expect(extension?.totalOf('minute'), why).toBe(45)
  })
})
