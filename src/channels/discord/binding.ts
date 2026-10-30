import type { OperatorLog } from '../../operator-log.js'
import { bind, type ChannelBinding } from '../../serve.js'
import { DiscordAdapter, type DiscordAdapterLogRecord } from './discord-adapter.js'
import type { DiscordEventLogRecord } from './discord-events.js'
import type { DiscordEnv } from './env-config.js'
import { GatewayTransport, type GatewayLogRecord, type GatewaySocket } from './gateway-transport.js'
import { HttpDiscordApi } from './http-discord-api.js'

/**
 * Everything this Channel has to say to an operator: its Transport's, the event
 * reader's, and the Adapter's own.
 */
export type DiscordLogRecord = GatewayLogRecord | DiscordEventLogRecord | DiscordAdapterLogRecord

/** Where it says it, which the composition root widens to every other part of roma. */
export type DiscordLog = OperatorLog<DiscordLogRecord>

/** Discord, built and paired with the socket its events arrive over. */
export function discordBinding(discord: DiscordEnv, log: DiscordLog): ChannelBinding {
  const api = new HttpDiscordApi({ botToken: discord.botToken, apiBase: discord.apiBase })

  return bind(
    new DiscordAdapter({ api, log }),
    new GatewayTransport({
      token: discord.botToken,
      url: discord.gatewayUrl,
      connect: webSocket,
      api,
      log,
    }),
  )
}

function webSocket(url: string): GatewaySocket {
  const socket = new WebSocket(url)
  return {
    send: (frame) => {
      socket.send(frame)
    },
    close: (code) => {
      socket.close(code)
    },
    on: (event: 'message' | 'close' | 'error', listener: (arg: never) => void) => {
      if (event === 'message') {
        socket.addEventListener('message', ({ data }) => {
          ;(listener as (frame: string) => void)(typeof data === 'string' ? data : String(data))
        })
        return
      }
      if (event === 'close') {
        socket.addEventListener('close', ({ code }) => {
          ;(listener as (code: number) => void)(code)
        })
        return
      }
      socket.addEventListener('error', () => {
        // The event carries nothing an operator can act on — the standard gives
        // it no reason — and the close that follows carries the code, which
        // does. So this exists to keep the socket's own error from being an
        // unhandled one, and says the only true thing there is to say.
        ;(listener as (error: Error) => void)(new Error('the Gateway socket faulted'))
      })
    },
  }
}
