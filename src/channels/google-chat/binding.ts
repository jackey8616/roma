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
 * Google Chat, built and paired with the Transport its events arrive over.
 *
 * Half of a composition root and deliberately only half: what it takes to reach
 * this Channel is Chat's business and lives in Chat's directory, and what roma
 * *is* — one pool, one queue, one Audit Log, and every Channel it serves — is
 * `src/channels/main.ts`'s. So this builds a binding and hands it over rather
 * than starting anything, which is what lets one process serve a second Channel
 * without this file knowing there is one (ADR-0028).
 *
 * Nothing is decided here. Every number is `env-config.ts`'s, every rule about
 * what happens to a message is `serve.ts`'s, and every Chat fact is the
 * Adapter's.
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
  // `arraybuffer` because the response is a file rather than JSON, and the
  // default would have the library parse it as one — which for a PNG means a
  // throw at best and a mangled string at worst.
  const download: DownloadChatMedia = async (url) => {
    const response = await client.request({ url, method: 'GET', responseType: 'arraybuffer' })
    return new Uint8Array(response.data as ArrayBuffer)
  }

  // The subscription is opened, not created. Chat publishes to a topic somebody
  // provisioned and roma reads a subscription somebody provisioned — see
  // `readChatEnv`, and the ticket that says provisioning is out of scope.
  const subscription = new PubSub({ projectId: chat.projectId }).subscription(chat.subscription, {
    flowControl: { maxMessages: chat.maxMessages },
    // How long a message may stay un-acknowledged while its Task runs. Set
    // rather than left to the library, because roma holds a message for the
    // whole of a Task and that is minutes — the default would give up on one
    // mid-Turn and have it delivered again alongside the run still going.
    maxExtensionTime: Duration.from({ minutes: chat.maxLeaseMinutes }),
  })

  return bind(
    new GoogleChatAdapter({ api: new HttpChatApi({ send, download }), log }),
    new PubSubTransport({ subscription, log }),
  )
}
