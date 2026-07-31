import { randomInt } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'

/**
 * A PNG whose whole content is a stack of coloured stripes, built here rather
 * than committed.
 *
 * It exists for one question — does Claude Code's Read tool put an image's
 * *pixels* in front of the model — and that question can only be answered by an
 * assertion the model cannot satisfy any other way. A committed fixture could be
 * described from its name, its size, or a lucky guess; a stripe order drawn at
 * random per run cannot. Five stripes from six colours is one in 7776.
 *
 * No dependency, because a PNG is small enough to write: a signature, three
 * chunks, and `zlib` for the one that holds the pixels.
 * https://www.w3.org/TR/png-3/
 */

/**
 * The colours a stripe can be, and their exact pixels.
 *
 * Fully saturated primaries and secondaries rather than anything nameable two
 * ways. The assertion is a string comparison against these keys, so a shade that
 * invites "crimson" or "teal" would fail a run that had actually succeeded.
 */
export const STRIPE_COLOURS = {
  red: [0xff, 0x00, 0x00],
  green: [0x00, 0xff, 0x00],
  blue: [0x00, 0x00, 0xff],
  yellow: [0xff, 0xff, 0x00],
  magenta: [0xff, 0x00, 0xff],
  cyan: [0x00, 0xff, 0xff],
} as const satisfies Record<string, readonly [number, number, number]>

export type StripeColour = keyof typeof STRIPE_COLOURS

const STRIPE_NAMES = Object.keys(STRIPE_COLOURS) as StripeColour[]

/** Every colour name, for a prompt that has to list the alternatives. */
export function stripeColourNames(): StripeColour[] {
  return [...STRIPE_NAMES]
}

/**
 * A fresh stripe order, in which no stripe matches the one above it.
 *
 * The constraint is not decoration and it is not about the search space — five
 * from six with no adjacent repeat is 6×5⁴, one in 3750, which is as decisive as
 * anything here needs. It is that two adjacent stripes of one colour *are* one
 * thicker stripe, and there is nothing in the picture that says otherwise.
 *
 * Measured, not anticipated: the first live run drew `magenta, magenta` in the
 * middle and Claude Code answered with four colours for five stripes. The answer
 * was right about the image and the fixture was wrong about the question, which
 * is a failure that would have been read as the premise failing.
 *
 * `randomInt` rather than `Math.random()` for the unbiased draw; the bias would
 * not matter at this scale, but a reviewer should not have to work that out.
 */
export function randomStripes(count: number): StripeColour[] {
  const stripes: StripeColour[] = []
  while (stripes.length < count) {
    const next = STRIPE_NAMES[randomInt(STRIPE_NAMES.length)]!
    if (next !== stripes.at(-1)) stripes.push(next)
  }
  return stripes
}

/** Pull the stripe colours out of an answer, in the order they were said. */
export function stripeColoursIn(text: string): string[] {
  const anyColour = new RegExp(STRIPE_NAMES.join('|'), 'g')
  return [...text.toLowerCase().matchAll(anyColour)].map((match) => match[0])
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const WIDTH = 240
const STRIPE_HEIGHT = 60

/** The stripes, top to bottom, as the bytes of a PNG file. */
export function stripedPng(stripes: readonly StripeColour[]): Buffer {
  const height = STRIPE_HEIGHT * stripes.length
  // Every scanline is a filter byte and then RGB triples. Filter 0 — none —
  // because the picture is flat colour and compresses to nothing regardless.
  const raw = Buffer.alloc(height * (1 + WIDTH * 3))
  let at = 0
  for (const stripe of stripes) {
    const [r, g, b] = STRIPE_COLOURS[stripe]
    for (let row = 0; row < STRIPE_HEIGHT; row += 1) {
      raw[at] = 0
      at += 1
      for (let column = 0; column < WIDTH; column += 1, at += 3) {
        raw[at] = r
        raw[at + 1] = g
        raw[at + 2] = b
      }
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(WIDTH, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bits per channel
  header[9] = 2 // colour type 2 — truecolour, no alpha
  header[10] = 0 // the only compression method there is
  header[11] = 0 // the only filter method there is
  header[12] = 0 // not interlaced

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * The stripes read back out of a PNG's pixels, top to bottom.
 *
 * Here so that a live run cannot confuse its two failures. "The agent could not
 * tell you what is in this image" and "this file is not the image you think it
 * is" look identical from the assertion, and only one of them is about Claude
 * Code — so the encoder above is checked against its own output, for free,
 * immediately before the run that costs money.
 *
 * Deliberately not a general PNG reader: it only understands what `stripedPng`
 * writes, and throws rather than guessing at anything else.
 */
export function stripesInPng(png: Buffer): StripeColour[] {
  if (!png.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new Error('not a PNG')

  const chunks = new Map<string, Buffer[]>()
  for (let at = SIGNATURE.length; at + 12 <= png.length; ) {
    const length = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + length)
    if (png.readUInt32BE(at + 8 + length) !== crc32(png.subarray(at + 4, at + 8 + length))) {
      throw new Error(`chunk ${type} has a bad CRC`)
    }
    chunks.set(type, [...(chunks.get(type) ?? []), data])
    at += 12 + length
  }

  const header = chunks.get('IHDR')?.[0]
  if (header === undefined) throw new Error('no IHDR')
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  if (header[8] !== 8 || header[9] !== 2 || header[12] !== 0) {
    throw new Error('not 8-bit truecolour, non-interlaced')
  }

  const pixels = inflateSync(Buffer.concat(chunks.get('IDAT') ?? []))
  const stride = 1 + width * 3
  if (pixels.length !== height * stride) throw new Error('IDAT is the wrong size')

  const stripes: StripeColour[] = []
  // One pixel per stripe band is enough: `stripedPng` writes flat colour, so a
  // band that disagreed with itself would be a bug this cannot express.
  for (let row = 0; row < height; row += STRIPE_HEIGHT) {
    const at = row * stride + 1
    const rgb = [pixels[at], pixels[at + 1], pixels[at + 2]]
    const found = STRIPE_NAMES.find((name) => STRIPE_COLOURS[name].every((c, i) => c === rgb[i]))
    if (found === undefined) throw new Error(`row ${row} is not a stripe colour`)
    stripes.push(found)
  }
  return stripes
}

/** Length, type, data, CRC — the frame every PNG chunk arrives in. */
function chunk(type: string, data: Buffer): Buffer {
  const framed = Buffer.alloc(12 + data.length)
  framed.writeUInt32BE(data.length, 0)
  framed.write(type, 4, 'ascii')
  data.copy(framed, 8)
  // The CRC covers the type and the data, and not the length in front of them.
  framed.writeUInt32BE(crc32(framed.subarray(4, 8 + data.length)), 8 + data.length)
  return framed
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let byte = 0; byte < 256; byte += 1) {
    let remainder = byte
    for (let bit = 0; bit < 8; bit += 1) {
      remainder = remainder & 1 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1
    }
    table[byte] = remainder >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let remainder = 0xffffffff
  for (const byte of bytes) remainder = CRC_TABLE[(remainder ^ byte) & 0xff]! ^ (remainder >>> 8)
  return (remainder ^ 0xffffffff) >>> 0
}
