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

export type ChatLogRecord = PubSubLogRecord | ChatEventLogRecord

export type ChatLog = OperatorLog<ChatLogRecord>

export async function googleChatBinding(chat: ChatEnv, log: ChatLog): Promise<ChannelBinding> {
  const auth = new GoogleAuth({ scopes: [CHAT_SCOPE] })
  const client = await auth.getClient()
  const send: SendChatRequest = async ({ method, url, body }) => {
    const response = await client.request({ url, method, data: body })
    return response.data
  }
  const download: DownloadChatMedia = async (url) => {
    const response = await client.request({ url, method: 'GET', responseType: 'arraybuffer' })
    return new Uint8Array(response.data as ArrayBuffer)
  }

  const subscription = new PubSub({ projectId: chat.projectId }).subscription(chat.subscription, {
    flowControl: { maxMessages: chat.maxMessages },
    maxExtensionTime: Duration.from({ minutes: chat.maxLeaseMinutes }),
  })

  return bind(
    new GoogleChatAdapter({ api: new HttpChatApi({ send, download }), log }),
    new PubSubTransport({ subscription, log }),
  )
}
