import type { DiscordMessage } from './discord-events.js'

/**
 * As much of Discord's REST API as roma calls.
 *
 * Two calls, and both of them serve the inbound half: the words behind a
 * Quotation, and the bytes behind an Enclosure. Posting is stage 3's (#180) and
 * is not here, so today this is the whole of what roma asks Discord for over
 * HTTP — everything else arrives over the socket.
 *
 * A port rather than a client, for `ChatApi`'s reason: what a test needs on the
 * far side of seam 3 is a recording of what roma asked for, and a port shaped
 * like a library would make that double most of the library.
 */
export interface DiscordApi {
  /**
   * One message, by where it lives.
   *
   * Rejects where Discord refuses or does not answer, which the one caller turns
   * into no Quotation at all — the fallback and the unsupported case are one
   * code path on purpose (ADR-0029).
   */
  message(channelId: string, messageId: string): Promise<DiscordMessage>
  /**
   * The bytes behind an attachment.
   *
   * Rejects for the ordinary reason as well as the exceptional one: Discord's
   * attachment URLs expire, and a Task parked for the Shared Window can wait
   * hours (#173).
   */
  download(url: string): Promise<Uint8Array>
}
