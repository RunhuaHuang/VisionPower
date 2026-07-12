import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { readdir, chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_VISION_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const DEFAULT_VISION_MODEL = 'qwen3-vl-flash'
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_TOKENS = 2048
export const DEFAULT_MAX_IMAGES = 8
export const DEFAULT_MAX_RETRIES = 2
export const DEFAULT_CACHE_MAX_ENTRIES = 32
export const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000

export const VISION_MODEL_PRESETS = [
  { model: 'qwen3-vl-flash', label: 'Qwen3-VL Flash', baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'qwen3-vl-plus', label: 'Qwen3-VL Plus', baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'qwen3.6-flash', label: 'Qwen3.6 Flash', baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'minimax-m3', label: 'MiniMax-M3', baseUrl: 'https://api.minimax.chat/v1' },
  { model: 'gpt-4o', label: 'GPT-4o', baseUrl: 'https://api.openai.com/v1' },
  { model: 'gpt-4o-mini', label: 'GPT-4o mini', baseUrl: 'https://api.openai.com/v1' },
]

export function getDefaultBaseUrlForModel(model) {
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
export function getConfigFilePath(env = process.env) {
  return env.VISIONPOWER_CONFIG?.trim() || join(homedir(), '.visionpower', 'config.json')
}

// Skill-only state marker. The generated zero-dependency Skill script updates
// this after a successful model call/verification, so agents can remember that
// setup already worked and avoid repeating noisy config preflight checks.
export function getSkillStateFilePath(env = process.env) {
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

export async function markSkillConfigVerified(config, env = process.env) {
  await writeSkillStateFile({
    configVerified: true,
    verifiedAt: new Date().toISOString(),
    model: config.model,
    baseUrl: config.baseUrl,
  }, env)
}

export async function markSkillConfigNeedsSetup(reason, env = process.env) {
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

export function loadVisionConfig(env = process.env) {
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

export function saveVisionConfig(config, env = process.env) {
  const configPath = getConfigFilePath(env)
  const dir = dirname(configPath)
  // Ensure directory exists with restrictive permissions (0o700 = owner rwx only)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Atomic write: write to a temp file, then rename to final path.
  // This prevents a partially-written config.json if the process is killed mid-write.
  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, configPath)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    throw error
  }
}

