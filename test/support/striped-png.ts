import { randomInt } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'

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

export function stripeColourNames(): StripeColour[] {
  return [...STRIPE_NAMES]
}

export function randomStripes(count: number): StripeColour[] {
  const stripes: StripeColour[] = []
  while (stripes.length < count) {
    const next = STRIPE_NAMES[randomInt(STRIPE_NAMES.length)]!
    if (next !== stripes.at(-1)) stripes.push(next)
  }
  return stripes
}

export function stripeColoursIn(text: string): string[] {
  const anyColour = new RegExp(STRIPE_NAMES.join('|'), 'g')
  return [...text.toLowerCase().matchAll(anyColour)].map((match) => match[0])
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const WIDTH = 240
const STRIPE_HEIGHT = 60

export function stripedPng(stripes: readonly StripeColour[]): Buffer {
  const height = STRIPE_HEIGHT * stripes.length
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
  header[8] = 8
  header[9] = 2
  header[10] = 0
  header[11] = 0
  header[12] = 0

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function stripesInPng(png: Buffer): StripeColour[] {
  if (!png.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new Error('not a PNG')

  const chunks = new Map<string, Buffer[]>()
  for (let at = SIGNATURE.length; at + 12 <= png.length;) {
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
  for (let row = 0; row < height; row += STRIPE_HEIGHT) {
    const at = row * stride + 1
    const rgb = [pixels[at], pixels[at + 1], pixels[at + 2]]
    const found = STRIPE_NAMES.find((name) => STRIPE_COLOURS[name].every((c, i) => c === rgb[i]))
    if (found === undefined) throw new Error(`row ${row} is not a stripe colour`)
    stripes.push(found)
  }
  return stripes
}

function chunk(type: string, data: Buffer): Buffer {
  const framed = Buffer.alloc(12 + data.length)
  framed.writeUInt32BE(data.length, 0)
  framed.write(type, 4, 'ascii')
  data.copy(framed, 8)
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
