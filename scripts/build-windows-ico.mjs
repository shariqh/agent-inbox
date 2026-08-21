#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngSize(bytes, path) {
  if (bytes.length < 24 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`Windows icon input is not a PNG: ${path}`)
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width !== height || ![16, 32, 256].includes(width)) {
    throw new Error(`Windows icon PNG must be square and 16, 32, or 256 pixels: ${path}`)
  }
  return width
}

function buildIco(paths) {
  if (paths.length !== 3) throw new Error('Windows icon requires exactly 16, 32, and 256 pixel PNGs')
  const images = paths.map((path) => {
    const bytes = readFileSync(path)
    return { bytes, size: pngSize(bytes, path) }
  }).sort((left, right) => left.size - right.size)
  if (images.map(({ size }) => size).join(',') !== '16,32,256') {
    throw new Error('Windows icon requires exactly one 16, 32, and 256 pixel PNG')
  }

  const headerSize = 6 + images.length * 16
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let imageOffset = headerSize
  for (const [index, image] of images.entries()) {
    const entryOffset = 6 + index * 16
    header[entryOffset] = image.size === 256 ? 0 : image.size
    header[entryOffset + 1] = image.size === 256 ? 0 : image.size
    header.writeUInt16LE(1, entryOffset + 4)
    header.writeUInt16LE(32, entryOffset + 6)
    header.writeUInt32LE(image.bytes.length, entryOffset + 8)
    header.writeUInt32LE(imageOffset, entryOffset + 12)
    imageOffset += image.bytes.length
  }
  return Buffer.concat([header, ...images.map(({ bytes }) => bytes)])
}

const [output, ...inputs] = process.argv.slice(2)
if (!output || inputs.length !== 3) {
  process.stderr.write('usage: build-windows-ico.mjs <output.ico> <16.png> <32.png> <256.png>\n')
  process.exitCode = 2
} else {
  try {
    writeFileSync(resolve(output), buildIco(inputs.map((input) => resolve(input))))
  } catch (err) {
    process.stderr.write(`build-windows-ico: ${err.message}\n`)
    process.exitCode = 1
  }
}
