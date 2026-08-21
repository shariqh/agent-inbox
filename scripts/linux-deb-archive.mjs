import { createHash } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const AR_MAGIC = Buffer.from('!<arch>\n')
const TAR_BLOCK = 512

export class LinuxDebArchiveError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LinuxDebArchiveError'
  }
}

function readExactly(fd, length, position, label) {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const count = readSync(fd, buffer, offset, length - offset, position + offset)
    if (count === 0) throw new LinuxDebArchiveError(`${label} ended unexpectedly`)
    offset += count
  }
  return buffer
}

function parseDecimal(bytes, label) {
  const value = bytes.toString('ascii').trim()
  if (!/^\d+$/.test(value)) throw new LinuxDebArchiveError(`${label} is not decimal`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new LinuxDebArchiveError(`${label} exceeds the safe integer range`)
  return parsed
}

function parseOctal(bytes, label) {
  if ((bytes[0] ?? 0) & 0x80) {
    throw new LinuxDebArchiveError(`${label} uses unsupported base-256 encoding`)
  }
  const value = bytes.toString('ascii').replace(/\0.*$/s, '').trim()
  if (!/^[0-7]+$/.test(value)) throw new LinuxDebArchiveError(`${label} is not octal`)
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed)) throw new LinuxDebArchiveError(`${label} exceeds the safe integer range`)
  return parsed
}

function hashSpan(fd, offset, size) {
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(size, 1)))
  let remaining = size
  let position = offset
  while (remaining > 0) {
    const wanted = Math.min(chunk.length, remaining)
    const count = readSync(fd, chunk, 0, wanted, position)
    if (count === 0) throw new LinuxDebArchiveError('archive member ended unexpectedly')
    hash.update(chunk.subarray(0, count))
    remaining -= count
    position += count
  }
  return hash.digest('hex')
}

export function parseArArchive(path) {
  const artifact = resolve(path)
  const fd = openSync(artifact, 'r')
  try {
    const size = fstatSync(fd).size
    if (size < AR_MAGIC.length || !readExactly(fd, AR_MAGIC.length, 0, 'ar global header').equals(AR_MAGIC)) {
      throw new LinuxDebArchiveError('DEB is missing the ar global header')
    }
    const members = []
    let offset = AR_MAGIC.length
    while (offset < size) {
      if (size - offset < 60) throw new LinuxDebArchiveError('ar member header is truncated')
      const header = readExactly(fd, 60, offset, 'ar member header')
      if (header.subarray(58, 60).toString('ascii') !== '`\n') {
        throw new LinuxDebArchiveError('ar member header has an invalid trailer')
      }
      const rawName = header.subarray(0, 16).toString('ascii').trim()
      if (rawName.startsWith('/') || rawName.includes('..')) {
        throw new LinuxDebArchiveError(`ar member has an unsafe name: ${rawName}`)
      }
      const name = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName
      if (!name || name.includes('/')) {
        throw new LinuxDebArchiveError(`ar member name is unsupported: ${rawName}`)
      }
      const memberSize = parseDecimal(header.subarray(48, 58), `ar member ${name} size`)
      const dataOffset = offset + 60
      const end = dataOffset + memberSize
      if (end > fstatSync(fd).size) throw new LinuxDebArchiveError(`ar member ${name} is truncated`)
      members.push({
        name,
        timestamp: parseDecimal(header.subarray(16, 28), `ar member ${name} timestamp`),
        uid: parseDecimal(header.subarray(28, 34), `ar member ${name} uid`),
        gid: parseDecimal(header.subarray(34, 40), `ar member ${name} gid`),
        mode: parseOctal(header.subarray(40, 48), `ar member ${name} mode`),
        size: memberSize,
        dataOffset,
        sha256: hashSpan(fd, dataOffset, memberSize),
      })
      offset = end
      if (memberSize % 2 === 1) {
        if (readExactly(fd, 1, offset, `ar member ${name} padding`)[0] !== 0x0a) {
          throw new LinuxDebArchiveError(`ar member ${name} has invalid padding`)
        }
        offset += 1
      }
    }
    return members
  } finally {
    closeSync(fd)
  }
}

export function readArMember(path, member) {
  const fd = openSync(resolve(path), 'r')
  try {
    return readExactly(fd, member.size, member.dataOffset, `ar member ${member.name}`)
  } finally {
    closeSync(fd)
  }
}

export function sha256LargeFile(path) {
  const fd = openSync(resolve(path), 'r')
  try {
    return hashSpan(fd, 0, fstatSync(fd).size)
  } finally {
    closeSync(fd)
  }
}

function fieldText(header, start, length) {
  return header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
}

function tarPath(header) {
  const name = fieldText(header, 0, 100)
  const prefix = fieldText(header, 345, 155)
  return prefix ? `${prefix}/${name}` : name
}

function normalizeTarPath(path) {
  if (path === '.' || path === './') return '.'
  const normalized = path.replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new LinuxDebArchiveError(`tar entry has an unsafe path: ${path}`)
  }
  return normalized
}

function tarChecksum(header) {
  const expected = parseOctal(header.subarray(148, 156), 'tar header checksum')
  let actual = 0
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  if (actual !== expected) {
    throw new LinuxDebArchiveError(`tar header checksum mismatch: expected ${expected}, found ${actual}`)
  }
}

function readTarPayload(fd, position, size, capture) {
  const hash = createHash('sha256')
  const chunks = capture ? [] : null
  const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(size, 1)))
  let remaining = size
  let offset = position
  while (remaining > 0) {
    const wanted = Math.min(chunk.length, remaining)
    const count = readSync(fd, chunk, 0, wanted, offset)
    if (count === 0) throw new LinuxDebArchiveError('tar payload ended unexpectedly')
    const bytes = chunk.subarray(0, count)
    hash.update(bytes)
    if (chunks) chunks.push(Buffer.from(bytes))
    remaining -= count
    offset += count
  }
  return {
    sha256: hash.digest('hex'),
    content: chunks ? Buffer.concat(chunks) : undefined,
  }
}

function parsePax(content) {
  const values = {}
  let offset = 0
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset)
    if (space < 0) throw new LinuxDebArchiveError('PAX record has no length separator')
    const lengthText = content.subarray(offset, space).toString('ascii')
    if (!/^\d+$/.test(lengthText)) throw new LinuxDebArchiveError('PAX record length is invalid')
    const length = Number(lengthText)
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > content.length) {
      throw new LinuxDebArchiveError('PAX record length is out of bounds')
    }
    const record = content.subarray(space + 1, offset + length)
    if (record.at(-1) !== 0x0a) throw new LinuxDebArchiveError('PAX record is missing its newline')
    const equals = record.indexOf(0x3d)
    if (equals <= 0) throw new LinuxDebArchiveError('PAX record has no key/value separator')
    const key = record.subarray(0, equals).toString('utf8')
    const value = record.subarray(equals + 1, -1).toString('utf8')
    if (Object.hasOwn(values, key)) throw new LinuxDebArchiveError(`duplicate PAX key: ${key}`)
    values[key] = value
    offset += length
  }
  return values
}

function gnuLongValue(content, label) {
  if (content.length < 2 || content.at(-1) !== 0) {
    throw new LinuxDebArchiveError(`${label} is not NUL terminated`)
  }
  const value = content.subarray(0, -1).toString('utf8')
  if (!value || value.includes('\0')) throw new LinuxDebArchiveError(`${label} is invalid`)
  return value
}

function paxInteger(value, label) {
  if (!/^\d+$/.test(value)) throw new LinuxDebArchiveError(`${label} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new LinuxDebArchiveError(`${label} exceeds the safe integer range`)
  return parsed
}

export function parseTarArchive(path, { capturePaths = [] } = {}) {
  const wanted = new Set(capturePaths)
  const fd = openSync(resolve(path), 'r')
  const entries = []
  const headers = []
  const seen = new Set()
  let pendingName
  let pendingLink
  let pendingPax
  let position = 0
  let zeroBlocks = 0
  try {
    const archiveSize = fstatSync(fd).size
    while (position < archiveSize) {
      if (archiveSize - position < TAR_BLOCK) throw new LinuxDebArchiveError('tar header is truncated')
      const header = readExactly(fd, TAR_BLOCK, position, 'tar header')
      position += TAR_BLOCK
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1
        if (zeroBlocks === 2) {
          const trailing = Buffer.alloc(1024 * 1024)
          while (position < archiveSize) {
            const count = readSync(fd, trailing, 0, Math.min(trailing.length, archiveSize - position), position)
            if (count === 0) throw new LinuxDebArchiveError('tar trailing bytes ended unexpectedly')
            if (!trailing.subarray(0, count).every((byte) => byte === 0)) {
              throw new LinuxDebArchiveError('tar archive has nonzero trailing bytes')
            }
            position += count
          }
        }
        continue
      }
      if (zeroBlocks !== 0) throw new LinuxDebArchiveError('tar archive has an isolated zero block')
      tarChecksum(header)
      const magic = header.subarray(257, 263).toString('ascii')
      if (magic !== 'ustar\0' && magic !== 'ustar ') {
        throw new LinuxDebArchiveError(`tar header has unsupported magic: ${JSON.stringify(magic)}`)
      }
      const type = String.fromCharCode(header[156] || 0)
      const size = parseOctal(header.subarray(124, 136), 'tar entry size')
      const rawPath = tarPath(header)
      const metadata = {
        path: rawPath,
        type,
        mode: parseOctal(header.subarray(100, 108), `tar entry ${rawPath} mode`),
        uid: parseOctal(header.subarray(108, 116), `tar entry ${rawPath} uid`),
        gid: parseOctal(header.subarray(116, 124), `tar entry ${rawPath} gid`),
        size,
        mtime: parseOctal(header.subarray(136, 148), `tar entry ${rawPath} mtime`),
        uname: fieldText(header, 265, 32),
        gname: fieldText(header, 297, 32),
      }
      headers.push(metadata)
      const special = type === 'L' || type === 'K' || type === 'x'
      const payload = readTarPayload(fd, position, size, special)
      position += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
      if (position > archiveSize) throw new LinuxDebArchiveError(`tar entry ${rawPath} is truncated`)

      if (type === 'L') {
        if (pendingName !== undefined) throw new LinuxDebArchiveError('duplicate pending GNU long path')
        pendingName = gnuLongValue(payload.content, 'GNU long path')
        continue
      }
      if (type === 'K') {
        if (pendingLink !== undefined) throw new LinuxDebArchiveError('duplicate pending GNU long link')
        pendingLink = gnuLongValue(payload.content, 'GNU long link')
        continue
      }
      if (type === 'x') {
        if (pendingPax !== undefined) throw new LinuxDebArchiveError('duplicate pending PAX header')
        pendingPax = parsePax(payload.content)
        continue
      }
      if (!['\0', '0', '2', '5'].includes(type)) {
        throw new LinuxDebArchiveError(`tar entry ${rawPath} has unsupported type ${JSON.stringify(type)}`)
      }

      const pax = pendingPax ?? {}
      const effectiveSize = pax.size === undefined ? size : paxInteger(pax.size, 'PAX size')
      if (effectiveSize !== size) {
        throw new LinuxDebArchiveError(`tar entry ${rawPath} PAX size disagrees with its header`)
      }
      const pathValue = pax.path ?? pendingName ?? rawPath
      const link = pax.linkpath ?? pendingLink ?? fieldText(header, 157, 100)
      const normalized = normalizeTarPath(pathValue)
      if (seen.has(normalized)) throw new LinuxDebArchiveError(`duplicate tar path: ${normalized}`)
      seen.add(normalized)
      for (const key of Object.keys(pax)) {
        if (!['path', 'linkpath', 'size', 'mtime', 'uid', 'gid', 'uname', 'gname'].includes(key)) {
          throw new LinuxDebArchiveError(`unsupported PAX key: ${key}`)
        }
      }
      const entry = {
        ...metadata,
        path: normalized,
        type: type === '\0' ? '0' : type,
        link,
        mtime: pax.mtime === undefined ? metadata.mtime : paxInteger(pax.mtime, 'PAX mtime'),
        uid: pax.uid === undefined ? metadata.uid : paxInteger(pax.uid, 'PAX uid'),
        gid: pax.gid === undefined ? metadata.gid : paxInteger(pax.gid, 'PAX gid'),
        uname: pax.uname ?? metadata.uname,
        gname: pax.gname ?? metadata.gname,
      }
      if (entry.type === '2') {
        if (size !== 0) throw new LinuxDebArchiveError(`tar symlink ${normalized} has payload bytes`)
        const resolvedLink = posix.normalize(posix.join(posix.dirname(normalized), link))
        if (
          !link ||
          link.startsWith('/') ||
          resolvedLink === '..' ||
          resolvedLink.startsWith('../') ||
          resolvedLink.startsWith('/')
        ) {
          throw new LinuxDebArchiveError(`tar symlink ${normalized} has an unsafe target: ${link}`)
        }
      } else if (link) {
        throw new LinuxDebArchiveError(`nonsymlink tar entry ${normalized} has a link target`)
      }
      if (entry.type === '5' && size !== 0) {
        throw new LinuxDebArchiveError(`tar directory ${normalized} has payload bytes`)
      }
      if (entry.type === '0') {
        const actualPayload = readTarPayload(
          fd,
          position - Math.ceil(size / TAR_BLOCK) * TAR_BLOCK,
          size,
          wanted.has(normalized),
        )
        entry.sha256 = actualPayload.sha256
        if (actualPayload.content) entry.content = actualPayload.content
      }
      entries.push(entry)
      pendingName = undefined
      pendingLink = undefined
      pendingPax = undefined
    }
    if (zeroBlocks < 2) throw new LinuxDebArchiveError('tar archive is missing its end markers')
    if (pendingName !== undefined || pendingLink !== undefined || pendingPax !== undefined) {
      throw new LinuxDebArchiveError('tar archive ends with unapplied extension metadata')
    }
    return { entries, headers }
  } finally {
    closeSync(fd)
  }
}

export function withDebTarFile({ deb, dpkgDeb = '/usr/bin/dpkg-deb', member }, callback) {
  const option = member === 'control'
    ? '--ctrl-tarfile'
    : member === 'data'
      ? '--fsys-tarfile'
      : null
  if (!option) throw new LinuxDebArchiveError(`unsupported DEB tar member: ${String(member)}`)
  const work = mkdtempSync(join(tmpdir(), 'agent-inbox-deb-tar-'))
  const tar = join(work, `${member}.tar`)
  const fd = openSync(tar, 'w', 0o600)
  try {
    execFileSync(dpkgDeb, [option, resolve(deb)], {
      env: { LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC' },
      stdio: ['ignore', fd, 'pipe'],
      timeout: 10 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  } finally {
    closeSync(fd)
  }
  try {
    return callback(tar)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
