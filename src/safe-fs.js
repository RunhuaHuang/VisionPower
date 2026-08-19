import { constants as fsConstants, closeSync, fstatSync, futimesSync, lstatSync, openSync, readSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

function sameSafeFileVersion(before, after) {
  return before.isFile()
    && after.isFile()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
}

function safeStatNumber(value, label) {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} is outside JavaScript's safe integer range`)
    }
    return Number(value)
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is outside JavaScript's safe integer range`)
  }
  return value
}

function assertSafeMetadata(fileStat, {
  maxBytes,
  requireOwnerOnly = false,
  rejectMultipleLinks = false,
  label = 'file',
} = {}) {
  if (!fileStat.isFile()) throw new Error(`${label} is not a regular file`)
  const size = safeStatNumber(fileStat.size, `${label} size`)
  if (size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit`)
  }
  const linkCount = safeStatNumber(fileStat.nlink, `${label} link count`)
  if (rejectMultipleLinks && linkCount !== 1) {
    throw new Error(`${label} must not have multiple hard links`)
  }
  if (requireOwnerOnly && process.platform !== 'win32') {
    const ownerId = safeStatNumber(fileStat.uid, `${label} owner id`)
    const mode = safeStatNumber(fileStat.mode, `${label} mode`)
    if (typeof process.getuid === 'function' && ownerId !== process.getuid()) {
      throw new Error(`${label} is not owned by the current user`)
    }
    if ((mode & 0o077) !== 0) {
      throw new Error(`${label} permissions must be owner-only`)
    }
  }
  return size
}

function openFlags() {
  return fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW)
}

export function safeReadFileSync(filePath, options) {
  const before = lstatSync(filePath, { bigint: true })
  if (before.isSymbolicLink()) throw new Error(`${options?.label ?? 'file'} must not be a symbolic link`)
  assertSafeMetadata(before, options)

  const fd = openSync(filePath, openFlags())
  try {
    const opened = fstatSync(fd, { bigint: true })
    const openedSize = assertSafeMetadata(opened, options)
    if (!sameSafeFileVersion(before, opened)) throw new Error(`${options?.label ?? 'file'} changed during read`)

    const data = Buffer.allocUnsafeSlow(openedSize)
    let offset = 0
    while (offset < data.length) {
      const bytesRead = readSync(fd, data, offset, data.length - offset, offset)
      if (bytesRead === 0) throw new Error(`${options?.label ?? 'file'} changed during read`)
      offset += bytesRead
    }
    const after = fstatSync(fd, { bigint: true })
    if (!sameSafeFileVersion(opened, after)) throw new Error(`${options?.label ?? 'file'} changed during read`)
    // Touch the recency timestamps through the already-verified descriptor:
    // a path-based utimes() after close would reopen the TOCTOU window. On the
    // open fd the file identity cannot be swapped. Failures are best-effort.
    if (options?.updateAccessTime) {
      try { futimesSync(fd, Date.now(), Date.now()) } catch { /* read-only FS, permissions, etc. */ }
    }
    return data
  } finally {
    closeSync(fd)
  }
}

export async function safeReadFile(filePath, options) {
  const before = await lstat(filePath, { bigint: true })
  if (before.isSymbolicLink()) throw new Error(`${options?.label ?? 'file'} must not be a symbolic link`)
  assertSafeMetadata(before, options)

  const handle = await open(filePath, openFlags())
  try {
    const opened = await handle.stat({ bigint: true })
    const openedSize = assertSafeMetadata(opened, options)
    if (!sameSafeFileVersion(before, opened)) throw new Error(`${options?.label ?? 'file'} changed during read`)

    const data = Buffer.allocUnsafeSlow(openedSize)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (bytesRead === 0) throw new Error(`${options?.label ?? 'file'} changed during read`)
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (!sameSafeFileVersion(opened, after)) throw new Error(`${options?.label ?? 'file'} changed during read`)
    if (options?.updateAccessTime) {
      try { await handle.utimes(new Date(), new Date()) } catch { /* best-effort, see sync variant */ }
    }
    return data
  } finally {
    await handle.close()
  }
}
