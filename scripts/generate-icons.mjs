import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

// All icons are generated from one self-contained design with Node built-ins.
// Linux needs PNGs at standard sizes; Windows needs a multi-resolution .ico.
const SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512]
const ICO_SIZES = [16, 32, 48, 64, 128, 256]

function distanceSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}

function sample(x, y) {
  const dx = Math.abs(x - 0.5)
  const dy = Math.abs(y - 0.5)
  const qx = Math.max(dx - 0.25, 0)
  const qy = Math.max(dy - 0.25, 0)
  if (Math.hypot(qx, qy) > 0.215) return [0, 0, 0, 0]
  const distance = Math.hypot(x - 0.5, y - 0.5)
  const annulus = distance > 0.25 && distance < 0.29
  const axle = Math.abs(y - 0.5) < 0.024 && x > 0.23 && x < 0.77
  const leftSpoke = distanceSegment(x, y, 0.39, 0.39, 0.61, 0.61) < 0.029
  const rightSpoke = distanceSegment(x, y, 0.39, 0.61, 0.61, 0.39) < 0.029
  const hub = distance < 0.074
  const inset = distance < 0.029
  if ((annulus || axle || leftSpoke || rightSpoke || hub) && !inset) {
    return y < 0.5 ? [251, 146, 37, 255] : [249, 105, 20, 255]
  }
  return [20, 21, 24, 255]
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4)
  let offset = 0
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const result = [0, 0, 0, 0]
    for (const oy of [0.25, 0.75]) for (const ox of [0.25, 0.75]) {
      const rgba = sample((x + ox) / size, (y + oy) / size)
      for (let channel = 0; channel < 4; channel++) result[channel] += rgba[channel] / 4
    }
    for (const channel of result) pixels[offset++] = Math.round(channel)
  }
  return pixels
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([len, name, data, checksum])
}

function png(size) {
  const pixels = render(size)
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let row = 0; row < size; row++) {
    pixels.copy(raw, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export function generateIcons(directory = 'build') {
  const root = resolve(directory)
  const icons = join(root, 'icons')
  mkdirSync(icons, { recursive: true })
  const rendered = new Map()
  for (const size of SIZES) {
    const data = png(size)
    rendered.set(size, data)
    writeFileSync(join(icons, `${size}x${size}.png`), data)
  }
  const table = Buffer.alloc(6 + 16 * ICO_SIZES.length)
  table.writeUInt16LE(1, 2)
  table.writeUInt16LE(ICO_SIZES.length, 4)
  let offset = table.length
  for (let index = 0; index < ICO_SIZES.length; index++) {
    const size = ICO_SIZES[index]
    const data = rendered.get(size)
    const position = 6 + index * 16
    table[position] = size === 256 ? 0 : size
    table[position + 1] = size === 256 ? 0 : size
    table[position + 2] = 0
    table.writeUInt16LE(1, position + 4)
    table.writeUInt16LE(32, position + 6)
    table.writeUInt32LE(data.length, position + 8)
    table.writeUInt32LE(offset, position + 12)
    offset += data.length
  }
  writeFileSync(join(root, 'icon.ico'), Buffer.concat([
    table, ...ICO_SIZES.map((size) => rendered.get(size))
  ]))
  console.log(`Generated Spindle desktop icons in ${root}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateIcons(process.argv[2])
}
