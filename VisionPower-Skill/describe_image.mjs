#!/usr/bin/env node

// AUTO-GENERATED — do not edit by hand.
// Source of truth: src/config.js + src/vision-core.js.
// Regenerate with: npm run build:skill

import { readFileSync, realpathSync } from 'node:fs'
import { readdir, chmod, mkdir, rename, stat, unlink, writeFile, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, extname, isAbsolute, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

const DEFAULT_VISION_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DEFAULT_VISION_MODEL = 'qwen3-vl-flash'
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_MAX_TOKENS = 2048
const DEFAULT_MAX_IMAGES = 8
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_CACHE_MAX_ENTRIES = 32
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000

const VISION_MODEL_PRESETS = [
  { model: 'qwen3-vl-flash', label: 'Qwen3-VL Flash', baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'qwen3-vl-plus', label: 'Qwen3-VL Plus', baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'qwen3.6-flash', label: 'Qwen3.6 Flash', baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'gpt-4o', label: 'GPT-4o', baseUrl: 'https://api.openai.com/v1' },
  { model: 'gpt-4o-mini', label: 'GPT-4o mini', baseUrl: 'https://api.openai.com/v1' },
]

function getDefaultBaseUrlForModel(model) {
  return VISION_MODEL_PRESETS.find((preset) => preset.model === model)?.baseUrl ?? DEFAULT_VISION_BASE_URL
}

function readEnvValue(env, names) {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return { name, value: String(value).trim() }
    }
  }

  return { name: names[0], value: '' }
}

function parsePositiveInteger(envValue, fallback) {
  if (!envValue.value) return fallback
  const trimmed = envValue.value
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${envValue.name} must be a positive integer`)
  }

  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${envValue.name} must be a positive integer`)
  }

  return parsed
}

function parseNonNegativeInteger(envValue, fallback) {
  if (!envValue.value) return fallback
  const trimmed = envValue.value
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${envValue.name} must be a non-negative integer`)
  }

  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${envValue.name} must be a non-negative integer`)
  }

  return parsed
}

function parseBoolean(envValue) {
  if (!envValue.value) return false
  const normalized = envValue.value.toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  throw new Error(`${envValue.name} must be a boolean (true/false)`)
}

function parseAllowedDirs(value) {
  if (!value.value) return []
  return value.value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

// Persistent config file (default ~/.visionpower/config.json). This lets the key
// and model survive without depending on a shell profile being sourced — which
// is what an agent's spawned shell often does NOT do. Env vars still win over it.
function getConfigFilePath(env = process.env) {
  return env.VISIONPOWER_CONFIG?.trim() || join(homedir(), '.visionpower', 'config.json')
}

// Skill-only state marker. The generated zero-dependency Skill script updates
// this after a successful model call/verification, so agents can remember that
// setup already worked and avoid repeating noisy config preflight checks.
function getSkillStateFilePath(env = process.env) {
  return env.VISIONPOWER_SKILL_STATE?.trim() || join(homedir(), '.visionpower', 'skill-state.json')
}

// Best-effort sweep of orphaned temp files left by a prior write that was killed
// before it could rename. Only touches files matching this exact state file's
// temp pattern (statePath.<pid>.<ts>.tmp) and only if older than the threshold,
// so it never touches unrelated user files.
async function cleanupStaleStateTempFiles(statePath, maxAgeMs) {
  const dir = dirname(statePath)
  const base = basename(statePath)
  const prefix = `${base}.`
  const suffix = '.tmp'
  const now = Date.now()
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) return
    const tempPath = join(dir, entry)
    try {
      const fileStat = await stat(tempPath)
      if (now - fileStat.mtimeMs > maxAgeMs) {
        await unlink(tempPath)
      }
    } catch {
      // A concurrent writer may have renamed/removed it; ignore.
    }
  }))
}

async function writeSkillStateFile(state, env) {
  const statePath = getSkillStateFilePath(env)
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`
  const content = `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`
  try {
    await writeFile(tempPath, content, { mode: 0o600, flag: 'wx' })
    await chmod(tempPath, 0o600)
    await rename(tempPath, statePath)
    // A fresh successful write is a safe moment to reap leftover temp files.
    await cleanupStaleStateTempFiles(statePath, 60 * 60 * 1000)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

function sanitizeSkillStateReason(reason) {
  return String(reason || 'configuration failed')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(api[-_ ]?key|token|secret)(["':=\s]+)([A-Za-z0-9._~+/=-]{8,})/gi, '$1$2[REDACTED]')
    .slice(0, 500)
}

async function markSkillConfigVerified(config, env = process.env) {
  await writeSkillStateFile({
    configVerified: true,
    verifiedAt: new Date().toISOString(),
    model: config.model,
    baseUrl: config.baseUrl,
  }, env)
}

async function markSkillConfigNeedsSetup(reason, env = process.env) {
  await writeSkillStateFile({
    configVerified: false,
    needsSetupAt: new Date().toISOString(),
    reason: sanitizeSkillStateReason(reason),
  }, env)
}

function loadConfigFile(env) {
  const configPath = getConfigFilePath(env)
  let raw
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`Could not read config file ${configPath}: ${error.message}`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON in config file ${configPath}: ${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file ${configPath} must contain a JSON object`)
  }
  return parsed
}

function stringFromFile(value, label) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`config file "${label}" must be a string`)
  }
  return value.trim() || undefined
}

function readFileStringValue(file, names) {
  for (const name of names) {
    const value = stringFromFile(file[name], name)
    if (value) return { name: `config file "${name}"`, value }
  }

  return { name: `config file "${names[0]}"`, value: '' }
}

function integerFromFile(value, label, { allowZero = false } = {}) {
  if (value === undefined || value === null) return undefined
  const valid = typeof value === 'number'
    && Number.isSafeInteger(value)
    && (allowZero ? value >= 0 : value > 0)
  if (!valid) {
    throw new Error(`config file "${label}" must be a ${allowZero ? 'non-negative' : 'positive'} integer`)
  }
  return value
}

function booleanFromFile(value, label) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`config file "${label}" must be a boolean`)
  }
  return value
}

function allowedDirsFromFile(value) {
  if (value === undefined || value === null) return undefined
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(',') : null
  if (!list) {
    throw new Error('config file "allowedDirs" must be an array or comma-separated string')
  }
  return list.map((item) => String(item).trim()).filter(Boolean)
}

function loadVisionConfig(env = process.env) {
  const file = loadConfigFile(env)

  const modelFile = readFileStringValue(file, ['model', 'VISIONPOWER_MODEL'])
  const model = readEnvValue(env, ['VISIONPOWER_MODEL']).value
    || modelFile.value
    || DEFAULT_VISION_MODEL

  const apiKeyFile = readFileStringValue(file, ['apiKey', 'VISIONPOWER_API_KEY', 'OPENAI_API_KEY'])
  const apiKey = readEnvValue(env, ['VISIONPOWER_API_KEY', 'OPENAI_API_KEY']).value
    || apiKeyFile.value
    || ''

  const baseUrlEnv = readEnvValue(env, ['VISIONPOWER_BASE_URL'])
  const fileBaseUrl = readFileStringValue(file, ['baseUrl', 'VISIONPOWER_BASE_URL'])
  const rawBaseUrl = baseUrlEnv.value || fileBaseUrl.value || getDefaultBaseUrlForModel(model)
  const baseUrlSource = baseUrlEnv.value
    ? baseUrlEnv.name
    : fileBaseUrl.value ? fileBaseUrl.name : 'VISIONPOWER_BASE_URL'
  const baseUrl = normalizeBaseUrl(rawBaseUrl, baseUrlSource)

  const allowedDirsEnv = readEnvValue(env, ['VISIONPOWER_ALLOWED_DIRS'])
  const debugEnv = readEnvValue(env, ['VISIONPOWER_DEBUG'])

  return {
    apiKey,
    model,
    baseUrl,
    allowedDirs: allowedDirsEnv.value
      ? parseAllowedDirs(allowedDirsEnv)
      : (allowedDirsFromFile(file.allowedDirs) ?? []),
    maxImageBytes: parsePositiveInteger(readEnvValue(env, ['VISIONPOWER_MAX_IMAGE_BYTES']), integerFromFile(file.maxImageBytes, 'maxImageBytes') ?? DEFAULT_MAX_IMAGE_BYTES),
    requestTimeoutMs: parsePositiveInteger(readEnvValue(env, ['VISIONPOWER_TIMEOUT_MS']), integerFromFile(file.timeoutMs, 'timeoutMs') ?? DEFAULT_REQUEST_TIMEOUT_MS),
    maxTokens: parsePositiveInteger(readEnvValue(env, ['VISIONPOWER_MAX_TOKENS']), integerFromFile(file.maxTokens, 'maxTokens') ?? DEFAULT_MAX_TOKENS),
    maxImages: parsePositiveInteger(readEnvValue(env, ['VISIONPOWER_MAX_IMAGES']), integerFromFile(file.maxImages, 'maxImages') ?? DEFAULT_MAX_IMAGES),
    maxRetries: parseNonNegativeInteger(readEnvValue(env, ['VISIONPOWER_MAX_RETRIES']), integerFromFile(file.maxRetries, 'maxRetries', { allowZero: true }) ?? DEFAULT_MAX_RETRIES),
    debug: debugEnv.value ? parseBoolean(debugEnv) : (booleanFromFile(file.debug, 'debug') ?? false),
    cache: resolveCacheConfig(env, file),
  }
}

// In-memory result cache config. The cache is purely process-local (never
// persisted), keyed by image bytes + prompt + model + maxTokens, so it can only
// ever return a hit for byte-identical inputs. It exists so a long-lived MCP
// server process does not bill a second model call for a repeated request in
// the same session. Env VISIONPOWER_CACHE=false disables it entirely.
function resolveCacheConfig(env, file) {
  const cacheEnv = readEnvValue(env, ['VISIONPOWER_CACHE'])
  let enabled = cacheEnv.value ? parseBoolean(cacheEnv) : (booleanFromFile(file.cache?.enabled, 'cache.enabled') ?? true)

  // maxEntries allows zero: a capacity of zero means "store nothing", which is
  // equivalent to disabling the cache (so 0 is a valid way to turn it off).
  const maxEntriesFile = integerFromFile(file.cache?.maxEntries, 'cache.maxEntries', { allowZero: true })
  const maxEntries = parseNonNegativeInteger(readEnvValue(env, ['VISIONPOWER_CACHE_MAX_ENTRIES']), maxEntriesFile ?? DEFAULT_CACHE_MAX_ENTRIES)

  const ttlMsFile = integerFromFile(file.cache?.ttlMs, 'cache.ttlMs', { allowZero: false })
  const ttlMs = parsePositiveInteger(readEnvValue(env, ['VISIONPOWER_CACHE_TTL_MS']), ttlMsFile ?? DEFAULT_CACHE_TTL_MS)

  if (maxEntries <= 0) enabled = false

  return { enabled, maxEntries, ttlMs }
}

function normalizeBaseUrl(value, name) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid http or https URL`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`)
  }

  const pathname = url.pathname.replace(/\/+$/, '')
  if (pathname.endsWith('/chat/completions')) {
    throw new Error(`${name} should not include /chat/completions`)
  }

  url.pathname = pathname || '/'
  url.search = ''
  url.hash = ''

  return url.toString().replace(/\/+$/, '')
}

const VISION_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

function debugLog(config, message) {
  if (config.debug) {
    process.stderr.write(`[visionpower] ${message}\n`)
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryDelayMs(attempt) {
  const base = Math.min(500 * 2 ** attempt, 4_000)
  return base + Math.floor(Math.random() * 250)
}

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

function detectImageMimeType(data) {
  const detectedMimeType =
    data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      ? 'image/jpeg'
      : data.length >= 8
        && data[0] === 0x89
        && data[1] === 0x50
        && data[2] === 0x4e
        && data[3] === 0x47
        && data[4] === 0x0d
        && data[5] === 0x0a
        && data[6] === 0x1a
        && data[7] === 0x0a
          ? 'image/png'
          : data.length >= 12
            && data.subarray(0, 4).toString('ascii') === 'RIFF'
            && data.subarray(8, 12).toString('ascii') === 'WEBP'
              ? 'image/webp'
              : data.length >= 6
                && (data.subarray(0, 6).toString('ascii') === 'GIF87a'
                  || data.subarray(0, 6).toString('ascii') === 'GIF89a')
                    ? 'image/gif'
                    : data.length >= 14
                      && data[0] === 0x42
                      && data[1] === 0x4d
                      && data[6] === 0x00
                      && data[7] === 0x00
                      && data[8] === 0x00
                      && data[9] === 0x00
                        ? 'image/bmp'
                        : null

  return detectedMimeType
}

function inferImageMimeTypeFromFile(filePath, data) {
  const ext = extname(filePath).toLowerCase()
  const expectedMimeType = MIME_BY_EXT[ext]
  if (!expectedMimeType) {
    throw new Error(`Unsupported image extension: ${ext || 'unknown'}`)
  }

  const detectedMimeType = detectImageMimeType(data)
  if (!detectedMimeType) throw new Error('File content is not a supported raster image')
  if (detectedMimeType !== expectedMimeType) {
    throw new Error(`Image extension does not match file content: ${ext} / ${detectedMimeType}`)
  }

  return detectedMimeType
}

function normalizePathForCompare(filePath) {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath
}

function isPathInsideDir(filePath, dirPath) {
  const normalizedFile = normalizePathForCompare(filePath)
  const normalizedDir = normalizePathForCompare(dirPath)
  return normalizedFile === normalizedDir || normalizedFile.startsWith(`${normalizedDir}${sep}`)
}

function assertAllowedPath(realImagePath, allowedDirs) {
  if (!allowedDirs || allowedDirs.length === 0) return

  const realAllowedDirs = allowedDirs.map((dir) => realpathSync(resolve(dir)))
  if (!realAllowedDirs.some((dir) => isPathInsideDir(realImagePath, dir))) {
    throw new Error(`image_path is outside configured allowed dirs: ${realImagePath}`)
  }
}

async function readLocalImageAsBase64(imagePath, config) {
  if (!isAbsolute(imagePath)) {
    throw new Error('image_path must be an absolute path')
  }

  let realImagePath
  try {
    realImagePath = await realpath(imagePath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`image_path does not exist: ${imagePath}`)
    }
    throw error
  }
  assertAllowedPath(realImagePath, config.allowedDirs)

  const fileStat = await stat(realImagePath)
  if (!fileStat.isFile()) {
    throw new Error('image_path must point to a regular image file')
  }
  if (fileStat.size <= 0) {
    throw new Error('Image file is empty')
  }
  if (fileStat.size > config.maxImageBytes) {
    throw new Error(`Image file is too large; max is ${Math.round(config.maxImageBytes / 1024 / 1024)}MB`)
  }

  const data = await readFile(realImagePath)
  if (data.length > config.maxImageBytes) {
    throw new Error(`Image file is too large; max is ${Math.round(config.maxImageBytes / 1024 / 1024)}MB`)
  }

  return {
    base64: data.toString('base64'),
    mimeType: inferImageMimeTypeFromFile(realImagePath, data),
  }
}

function isPrivateIpv4Address(ipAddress) {
  const [a, b] = ipAddress.split('.').map((part) => Number.parseInt(part, 10))
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
}

function ipv4FromMappedIpv6(ipAddress) {
  const dotted = ipAddress.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1]
  if (dotted && isIP(dotted) === 4) return dotted

  const hex = ipAddress.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) return null

  const high = Number.parseInt(hex[1], 16)
  const low = Number.parseInt(hex[2], 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

function isPrivateHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true

  const ipVersion = isIP(normalized)
  if (ipVersion === 4) {
    return isPrivateIpv4Address(normalized)
  }
  if (ipVersion === 6) {
    const mappedIpv4 = ipv4FromMappedIpv6(normalized)
    if (mappedIpv4) {
      return isPrivateIpv4Address(mappedIpv4)
    }

    return normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb')
  }

  return false
}

function normalizeImageUrl(imageUrl) {
  let url
  try {
    url = new URL(imageUrl)
  } catch {
    throw new Error('image_url must be a valid URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('image_url must use http or https')
  }
  if (url.username || url.password) {
    throw new Error('image_url must not include credentials')
  }
  if (isPrivateHostname(url.hostname)) {
    throw new Error('image_url must be publicly reachable; use image_path for local images')
  }

  return url.toString()
}

function normalizeBase64Image(imageBase64, imageMimeType, config) {
  const trimmed = imageBase64.trim()
  if (trimmed.startsWith('data:')) {
    throw new Error('image_base64 must not include a data: URI prefix')
  }

  const normalized = trimmed.replace(/\s+/g, '')
  if (!normalized) {
    throw new Error('image_base64 must not be empty')
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || /=[^=]/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error('image_base64 must be valid standard base64')
  }

  const padded = normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '=')
  const data = Buffer.from(padded, 'base64')
  const normalizedWithoutPadding = normalized.replace(/=+$/, '')
  const reencodedWithoutPadding = data.toString('base64').replace(/=+$/, '')
  if (reencodedWithoutPadding !== normalizedWithoutPadding) {
    throw new Error('image_base64 must be valid standard base64')
  }
  if (data.length <= 0) {
    throw new Error('image_base64 decoded to an empty image')
  }
  if (data.length > config.maxImageBytes) {
    throw new Error(`image_base64 is too large; max is ${Math.round(config.maxImageBytes / 1024 / 1024)}MB`)
  }

  const detectedMimeType = detectImageMimeType(data)
  if (!detectedMimeType) {
    throw new Error('image_base64 content is not a supported raster image')
  }
  if (imageMimeType && imageMimeType !== detectedMimeType) {
    throw new Error(`image_mime_type does not match image_base64 content: ${imageMimeType} / ${detectedMimeType}`)
  }

  return {
    base64: data.toString('base64'),
    mimeType: detectedMimeType,
  }
}

function countImageSources(params) {
  return ['image_path', 'image_url', 'image_base64'].filter((key) => Boolean(params[key])).length
}

function assertExactlyOneImageSource(params) {
  const sourceCount = countImageSources(params)
  if (sourceCount !== 1) {
    throw new Error('Provide exactly one of image_path, image_url, or image_base64 for each image')
  }
  if (params.image_mime_type && !params.image_base64) {
    throw new Error('image_mime_type can only be used with image_base64')
  }
}

async function imageBlockFromInput(params, config) {
  assertExactlyOneImageSource(params)

  if (params.image_path) {
    const image = await readLocalImageAsBase64(params.image_path, config)
    return {
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
    }
  }

  if (params.image_url) {
    return {
      type: 'image_url',
      image_url: { url: normalizeImageUrl(params.image_url) },
    }
  }

  const image = normalizeBase64Image(params.image_base64, params.image_mime_type, config)
  return {
    type: 'image_url',
    image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
  }
}

function normalizeImageInputs(params, config) {
  const hasImagesArray = Array.isArray(params.images) && params.images.length > 0
  const hasTopLevelImageSource = countImageSources(params) > 0
  const hasTopLevelImageField = hasTopLevelImageSource || Boolean(params.image_mime_type)

  if (hasImagesArray && hasTopLevelImageField) {
    throw new Error('Use either images[] or the top-level image fields, not both')
  }
  if (!hasImagesArray && !hasTopLevelImageSource) {
    if (params.image_mime_type) {
      throw new Error('image_mime_type can only be used with image_base64')
    }
    throw new Error('Provide one of image_path, image_url, image_base64, or images[]')
  }

  const images = hasImagesArray ? params.images : [params]
  if (images.length > config.maxImages) {
    throw new Error(`Too many images; max is ${config.maxImages}`)
  }

  return images.map((image, index) => ({
    label: `Image ${index + 1}`,
    input: image,
  }))
}

function extractTextContent(data) {
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

async function fetchVisionCompletion(requestBody, config) {
  const url = `${config.baseUrl}/chat/completions`

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController()
    // The timeout covers both establishing the request and reading the full
    // response body, so a stalled body download still aborts cleanly.
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs)

    let result
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
      const bodyText = await response.text()
      result = { ok: response.ok, status: response.status, bodyText }
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Vision model request timed out after ${Math.round(config.requestTimeoutMs / 1000)}s`)
      }
      if (attempt < config.maxRetries) {
        const wait = retryDelayMs(attempt)
        debugLog(config, `request error: ${error?.message ?? error}; retry ${attempt + 1}/${config.maxRetries} in ${wait}ms`)
        await delay(wait)
        continue
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }

    if (result.ok) {
      return result.bodyText
    }
    if (VISION_RETRYABLE_STATUS.has(result.status) && attempt < config.maxRetries) {
      const wait = retryDelayMs(attempt)
      debugLog(config, `upstream ${result.status}; retry ${attempt + 1}/${config.maxRetries} in ${wait}ms`)
      await delay(wait)
      continue
    }
    throw new Error(`Vision model API request failed (${result.status}): ${result.bodyText.slice(0, 500)}`)
  }
}

// In-process result cache. Lives only in memory (never persisted), and the key
// is derived from the exact request body the provider receives — model, the
// fully-resolved image payloads (bytes or URL), the prompt, and max_tokens.
// Structurally, two different inputs can never collide, so a hit is always a
// correct repeat of an earlier answer within the same session. A long-lived MCP
// server uses it to skip a billed model call when the agent resends the same
// image+question. A miss degrades gracefully to a normal provider call.
const resultCache = new Map()

function computeCacheKey(requestBody) {
  const hash = createHash('sha256')
  hash.update(`model=${requestBody.model}\n`)
  hash.update(`max_tokens=${requestBody.max_tokens}\n`)
  for (const part of requestBody.messages?.[0]?.content ?? []) {
    if (part.type === 'text') {
      hash.update(`text:${part.text}\n`)
    } else if (part.type === 'image_url') {
      // image_url.url holds either a public URL or a full data: URI (bytes),
      // so this captures the actual image content, not just a reference.
      hash.update(`image:${part.image_url?.url ?? ''}\n`)
    }
  }
  return hash.digest('hex')
}

function readResultCache(key, config) {
  if (!config.cache?.enabled) return undefined
  const entry = resultCache.get(key)
  if (!entry) return undefined
  if (Date.now() > entry.expiresAt) {
    resultCache.delete(key)
    return undefined
  }
  // Refresh recency so a frequently-repeated request stays hot (LRU eviction).
  resultCache.delete(key)
  resultCache.set(key, entry)
  debugLog(config, `cache hit (entries=${resultCache.size})`)
  return entry.text
}

function writeResultCache(key, text, config) {
  if (!config.cache?.enabled) return
  resultCache.set(key, { text, expiresAt: Date.now() + config.cache.ttlMs })
  // Evict oldest entries once over capacity (Map preserves insertion order).
  while (resultCache.size > config.cache.maxEntries) {
    const oldestKey = resultCache.keys().next().value
    resultCache.delete(oldestKey)
  }
}

async function describeImage(params, config) {
  const images = normalizeImageInputs(params, config)
  if (!config.apiKey) {
    throw new Error('API key is not configured. Set VISIONPOWER_API_KEY, OPENAI_API_KEY, or apiKey in ~/.visionpower/config.json')
  }

  const prompt = params.prompt?.trim()
    || 'Please describe this image in detail, including visible text, people, objects, scene, layout, colors, and any important details.'
  const orderedPrompt = images.length > 1
    ? `${prompt}\n\nAnalyze the images in the order provided. Refer to them exactly as Image 1, Image 2, and so on. Return your answer in the same order, with a separate section for each image.`
    : prompt
  // Resolve every image source in parallel so multi-image calls overlap disk I/O.
  const imageBlocks = await Promise.all(
    images.map((image) => imageBlockFromInput(image.input, config)),
  )
  const requestContent = images.flatMap((image, index) => [
    { type: 'text', text: `${image.label}:` },
    imageBlocks[index],
  ])
  requestContent.push({ type: 'text', text: orderedPrompt })

  const requestBody = {
    model: config.model,
    messages: [
      {
        role: 'user',
        content: requestContent,
      },
    ],
    max_tokens: config.maxTokens,
  }

  const cacheKey = computeCacheKey(requestBody)
  const cached = readResultCache(cacheKey, config)
  if (cached !== undefined) return cached

  const startedAt = Date.now()
  debugLog(config, `requesting model=${config.model} images=${images.length}`)
  const bodyText = await fetchVisionCompletion(requestBody, config)

  let data
  try {
    data = JSON.parse(bodyText)
  } catch {
    throw new Error('Vision model returned a non-JSON response')
  }
  if (data?.error?.message) {
    throw new Error(`Vision model API error: ${data.error.message}`)
  }

  const responseContent = extractTextContent(data)
  if (!responseContent) {
    throw new Error('Vision model returned no text content')
  }

  writeResultCache(cacheKey, responseContent, config)
  debugLog(config, `completed in ${Date.now() - startedAt}ms`)
  return responseContent
}

// ---- Skill entry point (self-contained; no install, no extra deps) ----

const HELP = `VisionPower — understand images with a vision model.

Usage:
  node describe_image.mjs --image-path <absolute path> [--prompt <text>]
  node describe_image.mjs --image-url <https url> [--prompt <text>]
  node describe_image.mjs request.json
  echo '<json request>' | node describe_image.mjs

The request JSON supports image_path / image_url / image_base64 / images[] / prompt.
Configure the API key in ~/.visionpower/config.json ({"apiKey":"...","model":"..."})
or via the VISIONPOWER_API_KEY environment variable. See SKILL.md for first-time setup.`

function parseSkillArgs(argv) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { positionals.push(arg); continue }
    const eq = arg.indexOf('=')
    if (eq !== -1) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (key === 'help' || next === undefined || next.startsWith('--')) {
      flags[key] = true
    } else {
      flags[key] = next
      i += 1
    }
  }
  return { flags, positionals }
}

async function readSkillStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function resolveSkillRequest(argv) {
  const { flags, positionals } = parseSkillArgs(argv)
  if (flags.help) return { help: true }

  const fileArg = flags.input || positionals[0]
  if (fileArg) {
    return { request: JSON.parse(await readFile(fileArg, 'utf8')) }
  }

  const request = {}
  if (flags['image-path']) request.image_path = flags['image-path']
  if (flags['image-url']) request.image_url = flags['image-url']
  if (flags['image-base64']) request.image_base64 = flags['image-base64']
  if (flags.mime) request.image_mime_type = flags.mime
  if (flags.prompt) request.prompt = flags.prompt

  if (request.image_path || request.image_url || request.image_base64) {
    return { request }
  }

  const raw = (await readSkillStdin()).trim()
  if (raw) return { request: JSON.parse(raw) }
  return { request }
}

async function mainSkill() {
  let resolved
  try {
    resolved = await resolveSkillRequest(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`VisionPower error: could not read request: ${error.message}\n`)
    process.exitCode = 1
    return
  }

  if (resolved.help) {
    process.stdout.write(`${HELP}\n`)
    return
  }

  try {
    const config = loadVisionConfig(process.env)
    const text = await describeImage(resolved.request, config)
    // Record that the Skill setup has successfully reached the provider. This
    // marker is intentionally best-effort: image analysis should never fail just
    // because the agent cannot write local state.
    await markSkillConfigVerified(config, process.env).catch(() => {})
    process.stdout.write(`${text}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isLikelySkillSetupError(message)) {
      await markSkillConfigNeedsSetup(message, process.env).catch(() => {})
    }
    process.stderr.write(`VisionPower error: ${message}\n`)
    process.exitCode = 1
  }
}

function isLikelySkillSetupError(message) {
  return /not configured|config file|VISIONPOWER_|OPENAI_API_KEY|base\s*url|unauthori[sz]ed|forbidden|invalid[^\n]*(api|key|token)|authentication|permission denied|\b401\b|\b403\b/i.test(message)
}

mainSkill()
