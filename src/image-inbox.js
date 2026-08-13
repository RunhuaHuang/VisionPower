import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'

const IMAGE_REF_PATTERN = /^vpimg_[A-Za-z0-9_-]{32}$/
const OWNED_FILE_PATTERN = /^(vpimg_[A-Za-z0-9_-]{32})\.(image|json)$/
const INBOX_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff',
])
const MAX_METADATA_BYTES = 16 * 1024
const ORPHAN_GRACE_MS = 60 * 1000
const STAGE_LOCK_NAME = '.stage.lock'
const STAGE_LOCK_STALE_MS = 60 * 1000
const STAGE_LOCK_HEARTBEAT_MS = 10 * 1000
const STAGE_LOCK_WAIT_MS = 5 * 1000

function inboxError(message, statusCode, code) {
  const error = new Error(message)
  if (statusCode) error.statusCode = statusCode
  if (code) error.code = code
  return error
}

function isDisposableEntryError(error) {
  return ['VISION_INBOX_INVALID_METADATA', 'VISION_INBOX_INVALID_DATA',
    'VISION_INBOX_INSECURE_FILE', 'VISION_INBOX_CHANGED'].includes(error?.code)
}

function assertImageRef(imageRef) {
  if (typeof imageRef !== 'string' || !IMAGE_REF_PATTERN.test(imageRef)) {
    throw inboxError('image_ref must be a valid VisionPower Inbox reference', 400, 'VISION_INBOX_INVALID_REF')
  }
  return imageRef
}

async function ensureInboxDir(config) {
  const dir = config.inbox?.dir
  if (!dir) throw new Error('VisionPower Inbox directory is not configured')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const dirStat = await lstat(dir)
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error('VisionPower Inbox path must be a real directory, not a symbolic link')
  }
  if (process.platform !== 'win32') {
    const wrongOwner = typeof process.getuid === 'function' && dirStat.uid !== process.getuid()
    const sharedPermissions = (dirStat.mode & 0o077) !== 0
    if (wrongOwner || sharedPermissions) {
      throw new Error('VisionPower Inbox directory must be owned by the current user with mode 0700 or stricter')
    }
  }
  return dir
}

function sameFile(before, after) {
  return before.isFile()
    && after.isFile()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
}

async function readOwnedFile(filePath, maxBytes, missingMessage) {
  let before
  try {
    before = await lstat(filePath, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') throw inboxError(missingMessage, 404, 'VISION_INBOX_NOT_FOUND')
    throw error
  }
  if (!before.isFile()) {
    // A symlink or another non-regular entry in the opaque namespace is unsafe
    // state, not a missing reference. Mark it disposable so Inbox cleanup can
    // remove the poisoned pair instead of preserving it forever.
    if (before.isSymbolicLink()) {
      throw inboxError('Staged image files must be regular owner-only files', 400, 'VISION_INBOX_INSECURE_FILE')
    }
    throw inboxError(missingMessage, 404, 'VISION_INBOX_NOT_FOUND')
  }
  if (process.platform !== 'win32') {
    const wrongOwner = typeof process.getuid === 'function' && Number(before.uid) !== process.getuid()
    const sharedPermissions = (Number(before.mode) & 0o077) !== 0
    if (wrongOwner || sharedPermissions) {
      throw inboxError('Staged image files must be owner-only', 400, 'VISION_INBOX_INSECURE_FILE')
    }
  }
  if (before.size <= 0n || before.size > BigInt(maxBytes)) {
    throw inboxError('Staged image data is invalid or exceeds the configured limit', 400, 'VISION_INBOX_INVALID_DATA')
  }

  const flags = fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW)
  let handle
  try {
    handle = await open(filePath, flags)
  } catch (error) {
    if (error?.code === 'ENOENT') throw inboxError(missingMessage, 404, 'VISION_INBOX_NOT_FOUND')
    if (error?.code === 'ELOOP') {
      throw inboxError('Staged image changed during read and was rejected', 409, 'VISION_INBOX_CHANGED')
    }
    throw error
  }
  try {
    const opened = await handle.stat({ bigint: true })
    if (!sameFile(before, opened)) {
      throw inboxError('Staged image changed during read and was rejected', 409, 'VISION_INBOX_CHANGED')
    }
    const data = Buffer.allocUnsafeSlow(Number(opened.size))
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (bytesRead === 0) {
        throw inboxError('Staged image changed during read and was rejected', 409, 'VISION_INBOX_CHANGED')
      }
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (!sameFile(opened, after)) {
      throw inboxError('Staged image changed during read and was rejected', 409, 'VISION_INBOX_CHANGED')
    }
    return data
  } finally {
    await handle.close()
  }
}

function parseMetadata(data, expectedId) {
  let metadata
  try {
    metadata = JSON.parse(data.toString('utf8'))
  } catch {
    throw inboxError('Staged image metadata is invalid', 400, 'VISION_INBOX_INVALID_METADATA')
  }
  const createdAtMs = Date.parse(metadata?.createdAt)
  const expiresAtMs = Date.parse(metadata?.expiresAt)
  if (metadata?.version !== 1
    || metadata.id !== expectedId
    || !INBOX_SUPPORTED_IMAGE_MIME_TYPES.has(metadata.mimeType)
    || !Number.isSafeInteger(metadata.bytes)
    || metadata.bytes <= 0
    || !/^[a-f0-9]{64}$/.test(metadata.sha256 || '')
    || !Number.isFinite(createdAtMs)
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= createdAtMs) {
    throw inboxError('Staged image metadata is invalid', 400, 'VISION_INBOX_INVALID_METADATA')
  }
  return { ...metadata, createdAtMs, expiresAtMs }
}

async function removeOwnedFiles(dir, id, assertLock = undefined) {
  if (assertLock) await assertLock()
  const results = await Promise.allSettled([
    unlink(join(dir, `${id}.image`)),
    unlink(join(dir, `${id}.json`)),
  ])
  return results.some((result) => result.status === 'fulfilled')
}

async function readMetadata(dir, id) {
  const data = await readOwnedFile(
    join(dir, `${id}.json`),
    MAX_METADATA_BYTES,
    'image_ref does not exist or has expired',
  )
  return parseMetadata(data, id)
}

async function cleanupImageInboxUnlocked(config, dir, now, assertLock = undefined) {
  const entries = await readdir(dir)
  const metadataIds = new Set()

  for (const entry of entries) {
    const match = entry.match(OWNED_FILE_PATTERN)
    if (!match || match[2] !== 'json') continue
    const id = match[1]
    metadataIds.add(id)
    try {
      const metadata = await readMetadata(dir, id)
      if (metadata.expiresAtMs <= now) await removeOwnedFiles(dir, id, assertLock)
      else {
        // Metadata is only useful when its paired image is still a regular,
        // owner-only file of the recorded size. A local process can replace
        // the image path after staging (for example with a symlink); leaving
        // that poisoned pair in the Inbox makes it count toward capacity and
        // causes every later read to fail. Remove deterministic unsafe states
        // while keeping transient I/O failures for a later sweep.
        let imageStat
        try {
          imageStat = await lstat(join(dir, `${id}.image`), { bigint: true })
        } catch (imageError) {
          if (imageError?.code === 'ENOENT') await removeOwnedFiles(dir, id, assertLock)
          continue
        }
        const wrongOwner = process.platform !== 'win32'
          && typeof process.getuid === 'function'
          && Number(imageStat.uid) !== process.getuid()
        const sharedPermissions = process.platform !== 'win32'
          && (Number(imageStat.mode) & 0o077) !== 0
        const invalidImage = !imageStat.isFile()
          || wrongOwner
          || sharedPermissions
          || imageStat.size <= 0n
          || imageStat.size !== BigInt(metadata.bytes)
        if (invalidImage) await removeOwnedFiles(dir, id, assertLock)
      }
    } catch (error) {
      if (error?.code === 'VISION_INBOX_LOCK_LOST') throw error
      // Files matching our exact random-handle namespace are VisionPower-owned.
      // Invalid/corrupt metadata cannot be used safely, so remove the pair.
      if (isDisposableEntryError(error)) {
        await removeOwnedFiles(dir, id, assertLock)
      }
      // Missing files are ordinary cleanup races. Other errors (EMFILE, EIO,
      // temporary access failures) are left untouched so a sweep can never
      // turn a transient read problem into data loss.
    }
  }

  // Clean data files left behind if a process died before publishing metadata.
  // Use lstat (not stat) for consistency with the rest of this module: stat
  // would follow a symlink and miss a dangling orphan, and we never follow
  // links inside the inbox namespace. A symlink in the owned namespace is not
  // something stageImageBuffer can create (it uses open 'wx'), so it is treated
  // as disposable alongside stale regular files.
  for (const entry of entries) {
    const match = entry.match(OWNED_FILE_PATTERN)
    if (!match || match[2] !== 'image' || metadataIds.has(match[1])) continue
    const filePath = join(dir, entry)
    try {
      const fileStat = await lstat(filePath)
      if ((fileStat.isFile() || fileStat.isSymbolicLink()) && now - fileStat.mtimeMs > ORPHAN_GRACE_MS) {
        if (assertLock) await assertLock()
        await unlink(filePath)
      }
    } catch (error) {
      if (error?.code === 'VISION_INBOX_LOCK_LOST') throw error
      // Concurrent cleanup/staging may already have removed it.
    }
  }
}

function inboxMaxBytes(config) {
  // Configs created before the aggregate Inbox budget was introduced still
  // work safely: one image is always allowed and old programmatic callers do
  // not receive a surprising TypeError.
  return config.inbox?.maxBytes ?? config.maxImageBytes
}

export async function cleanupImageInbox(config, now = Date.now()) {
  return withStageLock(config, async (dir, assertLock) => cleanupImageInboxUnlocked(config, dir, now, assertLock))
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function acquireStageLock(dir) {
  const lockPath = join(dir, STAGE_LOCK_NAME)
  const deadline = Date.now() + STAGE_LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      return { handle, lockPath }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const lockStat = await lstat(lockPath, { bigint: true })
        if (!lockStat.isFile() || Date.now() - Number(lockStat.mtimeMs) > STAGE_LOCK_STALE_MS) {
          // This is a lease lock. Never unlink an observed pathname directly:
          // it may be replaced between lstat() and unlink(). Atomic rename
          // revokes whatever lock currently occupies the canonical name;
          // every holder fences its critical writes with assertStageLockOwnership
          // below, so a live process that lost a stale lease cannot publish.
          const quarantinePath = `${lockPath}.stale.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
          try {
            await rename(lockPath, quarantinePath)
          } catch (renameError) {
            if (renameError?.code === 'ENOENT' || renameError?.code === 'EEXIST') continue
            throw renameError
          }
          await unlink(quarantinePath).catch((quarantineError) => {
            if (quarantineError?.code !== 'ENOENT') throw quarantineError
          })
          continue
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue
      }
      if (Date.now() >= deadline) {
        throw inboxError('VisionPower Inbox is busy; retry the upload', 503, 'VISION_INBOX_BUSY')
      }
      await wait(25 + Math.floor(Math.random() * 25))
    }
  }
}

function sameLockFile(held, current) {
  return held.isFile()
    && current.isFile()
    && held.dev === current.dev
    && held.ino === current.ino
    && held.birthtimeNs === current.birthtimeNs
}

async function assertStageLockOwnership(lock) {
  let current
  try {
    current = await lstat(lock.lockPath, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw inboxError('VisionPower Inbox lock lease was lost; retry the upload', 503, 'VISION_INBOX_LOCK_LOST')
    }
    throw error
  }
  const held = await lock.handle.stat({ bigint: true })
  if (!sameLockFile(held, current)) {
    throw inboxError('VisionPower Inbox lock lease was lost; retry the upload', 503, 'VISION_INBOX_LOCK_LOST')
  }
}

async function releaseStageLock(lock) {
  // A stale-lock reclaimer may have replaced the path while this process still
  // owns the original open handle. Never unlink by pathname alone: doing so
  // could delete the successor process's fresh lock and admit a third writer.
  try {
    const [held, current] = await Promise.all([
      lock.handle.stat({ bigint: true }),
      lstat(lock.lockPath, { bigint: true }),
    ])
    if (sameLockFile(held, current)) await unlink(lock.lockPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  } finally {
    await lock.handle.close().catch(() => {})
  }
}

async function withStageLock(config, task) {
  const dir = await ensureInboxDir(config)
  const lock = await acquireStageLock(dir)
  // Keep a live writer's lease fresh so slow filesystems cannot make it look
  // like a crashed process. Serialize heartbeat writes to avoid overlapping
  // FileHandle operations if one touch itself is delayed.
  let heartbeat = Promise.resolve()
  const heartbeatTimer = setInterval(() => {
    heartbeat = heartbeat
      .then(async () => {
        await assertStageLockOwnership(lock)
        const now = new Date()
        await lock.handle.utimes(now, now)
      })
      .catch(() => {})
  }, STAGE_LOCK_HEARTBEAT_MS)
  heartbeatTimer.unref?.()
  try {
    await assertStageLockOwnership(lock)
    return await task(dir, () => assertStageLockOwnership(lock))
  } finally {
    clearInterval(heartbeatTimer)
    await heartbeat
    // Lock cleanup is best-effort after the task has completed. Reporting a
    // successful staged write as failed here could make a caller retry and
    // create a duplicate; an unreleased file is safely reclaimed by the stale
    // lease path instead.
    await releaseStageLock(lock).catch(() => {})
  }
}

async function listStagedImagesUnlocked(config, dir, now, assertLock = undefined) {
  await cleanupImageInboxUnlocked(config, dir, now, assertLock)
  const entries = await readdir(dir)
  const result = []
  for (const entry of entries) {
    const match = entry.match(OWNED_FILE_PATTERN)
    if (!match || match[2] !== 'json') continue
    try {
      const metadata = await readMetadata(dir, match[1])
      if (metadata.expiresAtMs > now) {
        const publicMetadata = { ...metadata }
        delete publicMetadata.createdAtMs
        delete publicMetadata.expiresAtMs
        result.push(publicMetadata)
      }
    } catch (error) {
      // cleanupImageInbox already removes deterministically unsafe entries and
      // a missing file is an ordinary race. Propagate every other I/O failure:
      // silently omitting it here could under-count capacity and accept more
      // staged data while the filesystem is unhealthy.
      if (error?.code !== 'VISION_INBOX_NOT_FOUND' && !isDisposableEntryError(error)) throw error
    }
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function listStagedImages(config, now = Date.now()) {
  return withStageLock(config, async (dir, assertLock) => listStagedImagesUnlocked(config, dir, now, assertLock))
}

export async function stageImageBuffer(data, mimeType, config, now = Date.now()) {
  if (!Buffer.isBuffer(data) || data.length <= 0 || data.length > config.maxImageBytes) {
    throw inboxError('Staged image exceeds the configured per-image limit', 400)
  }
  if (!INBOX_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw inboxError('Staged image MIME type is not supported', 400)
  }
  return withStageLock(config, async (dir, assertLock) => {
    const existing = await listStagedImagesUnlocked(config, dir, now, assertLock)
    if (existing.length >= config.inbox.maxEntries) {
      throw inboxError(`VisionPower Inbox is full; max is ${config.inbox.maxEntries} images`, 409, 'VISION_INBOX_FULL')
    }
    const maxBytes = inboxMaxBytes(config)
    const usedBytes = existing.reduce((total, image) => total + image.bytes, 0)
    if (data.length > maxBytes || usedBytes > maxBytes - data.length) {
      throw inboxError(`VisionPower Inbox is full; max storage is ${maxBytes} bytes`, 409, 'VISION_INBOX_FULL')
    }

    const id = `vpimg_${randomBytes(24).toString('base64url')}`
    const dataPath = join(dir, `${id}.image`)
    const metadataPath = join(dir, `${id}.json`)
    const createdAt = new Date(now).toISOString()
    const expiresAt = new Date(now + config.inbox.ttlMs).toISOString()
    const metadata = {
      version: 1,
      id,
      mimeType,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      createdAt,
      expiresAt,
    }

    let dataCreated = false
    let metadataCreated = false
    try {
      // The data file is private and unpublished until metadata exists. Fence
      // the write anyway; should this lease have been revoked, cleanup removes
      // only this random orphan and it can never become a visible Inbox item.
      await assertLock()
      const dataHandle = await open(dataPath, 'wx', 0o600)
      try {
        dataCreated = true
        await dataHandle.writeFile(data)
        await dataHandle.sync()
      } finally {
        await dataHandle.close()
      }

      // Metadata is the publication point. A holder that lost its lease must
      // never publish after a successor admitted a new operation.
      await assertLock()
      const metadataHandle = await open(metadataPath, 'wx', 0o600)
      try {
        metadataCreated = true
        await metadataHandle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
        await metadataHandle.sync()
      } finally {
        await metadataHandle.close()
      }
      // Close the lease window around the publication point. If a process was
      // paused long enough for a successor to reclaim its stale lock, remove
      // this operation's private random pair before returning a reference.
      await assertLock()
      return metadata
    } catch (error) {
      if (metadataCreated) await unlink(metadataPath).catch(() => {})
      if (dataCreated) await unlink(dataPath).catch(() => {})
      throw error
    }
  })
}

export async function readStagedImage(imageRef, config, now = Date.now()) {
  const id = assertImageRef(imageRef)
  return withStageLock(config, async (dir, assertLock) => {
    await cleanupImageInboxUnlocked(config, dir, now, assertLock)
    const metadata = await readMetadata(dir, id)
    if (metadata.expiresAtMs <= now) {
      await removeOwnedFiles(dir, id, assertLock)
      throw inboxError('image_ref does not exist or has expired', 404, 'VISION_INBOX_NOT_FOUND')
    }
    if (metadata.bytes > config.maxImageBytes) {
      throw inboxError('Staged image exceeds the configured per-image limit', 400, 'VISION_INBOX_INVALID_DATA')
    }
    const data = await readOwnedFile(
      join(dir, `${id}.image`),
      config.maxImageBytes,
      'image_ref does not exist or has expired',
    )
    const digest = createHash('sha256').update(data).digest('hex')
    if (data.length !== metadata.bytes || digest !== metadata.sha256) {
      throw inboxError('Staged image failed integrity verification', 409, 'VISION_INBOX_INTEGRITY')
    }
    return { data, mimeType: metadata.mimeType, metadata }
  })
}

export async function deleteStagedImage(imageRef, config) {
  const id = assertImageRef(imageRef)
  return withStageLock(config, async (dir, assertLock) => removeOwnedFiles(dir, id, assertLock))
}
