import { Duration, PubSub } from '@google-cloud/pubsub'
import { GoogleAuth } from 'google-auth-library'
import type { OperatorLog } from '../../operator-log.js'
import { bind, type ChannelBinding } from '../../serve.js'
import type { ChatEnv } from './env-config.js'
import type { ChatEventLogRecord } from './chat-events.js'
import { GoogleChatAdapter } from './google-chat-adapter.js'
import {
  CHAT_SCOPE,
  HttpChatApi,
  type DownloadChatMedia,
  type SendChatRequest,
} from './http-chat-api.js'
import { PubSubTransport, type PubSubLogRecord } from './pubsub-transport.js'

/** Everything this Channel has to say to an operator: its Transport's and its own. */
export type ChatLogRecord = PubSubLogRecord | ChatEventLogRecord

/** Where it says it, which the composition root widens to every other part of roma. */
export type ChatLog = OperatorLog<ChatLogRecord>

/**
 * Google Chat, built and paired with the Transport its events arrive over, and
 * handed back for the composition root to serve. It starts nothing.
 */
export async function googleChatBinding(chat: ChatEnv, log: ChatLog): Promise<ChannelBinding> {
  // Application Default Credentials: a key file named by
  // GOOGLE_APPLICATION_CREDENTIALS, or the metadata server on a Google host.
  // Deliberately not roma's own mechanism — this one already exists, is already
  // documented, and is what the deployment's own tooling will have set up. It is
  // roma's own identity, and deliberately unrelated to either identity the agent
  // acts as: those are Reaches, and neither is constructed anywhere near here.
  const auth = new GoogleAuth({ scopes: [CHAT_SCOPE] })
  const client = await auth.getClient()
  const send: SendChatRequest = async ({ method, url, body }) => {
    const response = await client.request({ url, method, data: body })
    return response.data
  }
  // Enforced by `fence:gchat-download-is-bytes`.
  const download: DownloadChatMedia = async (url) => {
    const response = await client.request({ url, method: 'GET', responseType: 'arraybuffer' })
    return new Uint8Array(response.data as ArrayBuffer)
  }

  // The subscription is opened, not created. Chat publishes to a topic somebody
  // provisioned and roma reads a subscription somebody provisioned — see
  // `readChatEnv`, and the ticket that says provisioning is out of scope.
  const subscription = new PubSub({ projectId: chat.projectId }).subscription(chat.subscription, {
    flowControl: { maxMessages: chat.maxMessages },
    // Enforced by `fence:gchat-lease-is-set`.
    maxExtensionTime: Duration.from({ minutes: chat.maxLeaseMinutes }),
  })

  return bind(
    new GoogleChatAdapter({ api: new HttpChatApi({ send, download }), log }),
    new PubSubTransport({ subscription, log }),
  )
}
