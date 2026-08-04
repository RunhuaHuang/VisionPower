import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { readdir, chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_VISION_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const DEFAULT_VISION_MODEL = 'qwen3-vl-flash'
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
export const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647
export const DEFAULT_MAX_TOKENS = 2048
export const DEFAULT_MAX_IMAGES = 8
export const DEFAULT_MAX_RETRIES = 2
export const DEFAULT_CACHE_MAX_ENTRIES = 32
export const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000

export const VISION_MODEL_PRESETS = [
  // —— 国内（China）端点 ——
  { model: 'qwen3-vl-flash', label: { zh: 'Qwen3-VL Flash (阿里云百炼)', en: 'Qwen3-VL Flash (Alibaba Cloud)' }, baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'qwen3-vl-plus', label: { zh: 'Qwen3-VL Plus (阿里云百炼)', en: 'Qwen3-VL Plus (Alibaba Cloud)' }, baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'qwen3.6-flash', label: { zh: 'Qwen3.6 Flash (阿里云百炼)', en: 'Qwen3.6 Flash (Alibaba Cloud)' }, baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'minimax-m3', label: { zh: 'MiniMax-M3 (国内)', en: 'MiniMax-M3 (China)' }, baseUrl: 'https://api.minimaxi.com/v1' },
  { model: 'minimax-m3', label: { zh: 'MiniMax-M3 (海外)', en: 'MiniMax-M3 (Global)' }, baseUrl: 'https://api.minimax.io/v1' },
  // 福利预设：通过第三方中转站提供，key 留空由作者私下分发（小红书等渠道），
  // 不对外公布获取入口。welfare:true 让 WebUI 隐藏官方「获取 API Key」链接。
  // 注意 model 用大写 MiniMax-M3：该中转站的「福利」分组大小写敏感，小写
  // minimax-m3 会 503「无可用渠道」，只有大写才能命中已接通的渠道。
  { model: 'MiniMax-M3', label: { zh: 'MiniMax-M3 (福利)', en: 'MiniMax-M3 (Welfare)' }, baseUrl: 'https://api.prismaistudio.xyz:663/v1', welfare: true },
  { model: 'glm-4.6v', label: { zh: 'GLM-4.6V (智谱 BigModel 国内)', en: 'GLM-4.6V (Zhipu China)' }, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { model: 'glm-4.6v', label: { zh: 'GLM-4.6V (智谱 Z.AI 海外)', en: 'GLM-4.6V (Zhipu Global)' }, baseUrl: 'https://api.z.ai/api/paas/v4' },
  { model: 'glm-5v-turbo', label: { zh: 'GLM-5V-Turbo (智谱 BigModel 国内)', en: 'GLM-5V-Turbo (Zhipu China)' }, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { model: 'glm-5v-turbo', label: { zh: 'GLM-5V-Turbo (智谱 Z.AI 海外)', en: 'GLM-5V-Turbo (Zhipu Global)' }, baseUrl: 'https://api.z.ai/api/paas/v4' },
  { model: 'doubao-seed-2-1-turbo-260628', label: { zh: 'Doubao Seed 2.1 Turbo (火山方舟)', en: 'Doubao Seed 2.1 Turbo (Volcengine Ark)' }, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { model: 'doubao-seed-2-0-lite-260428', label: { zh: 'Doubao Seed 2.0 Lite (火山方舟)', en: 'Doubao Seed 2.0 Lite (Volcengine Ark)' }, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { model: 'kimi-k2.6', label: { zh: 'Kimi K2.6 (月之暗面 国内)', en: 'Kimi K2.6 (Moonshot China)' }, baseUrl: 'https://api.moonshot.cn/v1' },
  { model: 'kimi-k2.6', label: { zh: 'Kimi K2.6 (月之暗面 海外)', en: 'Kimi K2.6 (Moonshot Global)' }, baseUrl: 'https://api.moonshot.ai/v1' },
  { model: 'kimi-k2.7-code', label: { zh: 'Kimi K2.7 Code (月之暗面 国内)', en: 'Kimi K2.7 Code (Moonshot China)' }, baseUrl: 'https://api.moonshot.cn/v1' },
  { model: 'kimi-k2.7-code', label: { zh: 'Kimi K2.7 Code (月之暗面 海外)', en: 'Kimi K2.7 Code (Moonshot Global)' }, baseUrl: 'https://api.moonshot.ai/v1' },
  // —— 国际（International）端点 ——
  { model: 'gemini-3.6-flash', label: { zh: 'Gemini 3.6 Flash (Google)', en: 'Gemini 3.6 Flash (Google)' }, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { model: 'gpt-4o', label: { zh: 'GPT-4o (OpenAI)', en: 'GPT-4o (OpenAI)' }, baseUrl: 'https://api.openai.com/v1' },
  { model: 'gpt-4o-mini', label: { zh: 'GPT-4o mini (OpenAI)', en: 'GPT-4o mini (OpenAI)' }, baseUrl: 'https://api.openai.com/v1' },
]

export function getDefaultBaseUrlForModel(model) {
  const matches = VISION_MODEL_PRESETS.filter((preset) => preset.model === model)
  // A few model IDs (e.g. minimax-m3, kimi-k2.6) intentionally appear twice —
  // once for the China endpoint and once for the global one. When that happens
  // we cannot infer the correct base URL from the model alone, so fall back to
  // the default instead of silently picking the first (China) match and routing
  // a global user's traffic to the wrong region. The WebUI always persists
  // baseUrl alongside model, so this only affects hand-written configs that
  // omit baseUrl for an ambiguous model.
  if (matches.length === 1) return matches[0].baseUrl
  return DEFAULT_VISION_BASE_URL
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

// Sync twin of cleanupStaleStateTempFiles, used by the sync saveVisionConfig.
// Same prefix/suffix/mtime rules: only reaps <base>.<pid>.<ts>.tmp orphans
// older than maxAgeMs, so unrelated user files are never touched.
function cleanupStaleTempFilesSync(filePath, maxAgeMs) {
  const dir = dirname(filePath)
  const prefix = `${basename(filePath)}.`
  const suffix = '.tmp'
  const now = Date.now()
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue
    const tempPath = join(dir, entry)
    try {
      if (now - statSync(tempPath).mtimeMs > maxAgeMs) {
        unlinkSync(tempPath)
      }
    } catch {
      // A concurrent writer may have renamed/removed it; ignore.
    }
  }
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
  if (list.some((item) => typeof item !== 'string')) {
    throw new Error('config file "allowedDirs" entries must be strings')
  }
  return list.map((item) => item.trim()).filter(Boolean)
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
  const timeoutEnv = readEnvValue(env, ['VISIONPOWER_TIMEOUT_MS'])
  const timeoutFile = integerFromFile(file.timeoutMs, 'timeoutMs')
  const requestTimeoutMs = parsePositiveInteger(timeoutEnv, timeoutFile ?? DEFAULT_REQUEST_TIMEOUT_MS)
  if (requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    const source = timeoutEnv.value ? timeoutEnv.name : 'config file "timeoutMs"'
    throw new Error(`${source} must not exceed ${MAX_REQUEST_TIMEOUT_MS}`)
  }

  return {
    apiKey,
    model,
    baseUrl,
    allowedDirs: allowedDirsEnv.value
      ? parseAllowedDirs(allowedDirsEnv)
      : (allowedDirsFromFile(file.allowedDirs) ?? []),
    maxImageBytes: parsePositiveInteger(readEnvValue(env, ['VISIONPOWER_MAX_IMAGE_BYTES']), integerFromFile(file.maxImageBytes, 'maxImageBytes') ?? DEFAULT_MAX_IMAGE_BYTES),
    requestTimeoutMs,
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
  if (file.cache !== undefined && file.cache !== null
    && (typeof file.cache !== 'object' || Array.isArray(file.cache))) {
    throw new Error('config file "cache" must be an object')
  }
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

export function normalizeBaseUrl(value, name) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid http or https URL`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`)
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include credentials`)
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
    // A fresh successful write is a safe moment to reap leftover temp files
    // (e.g. from a prior save interrupted mid-write). Mirrors writeSkillStateFile.
    cleanupStaleTempFilesSync(configPath, 60 * 60 * 1000)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    throw error
  }
}

// Fields the WebUI is allowed to write into config.json. Unknown / prototype-
// polluting keys sent by the client are silently dropped. Kept here (next to
// the validators below) so the server and the validation pass always agree.
export const ALLOWED_CONFIG_KEYS = new Set([
  'apiKey', 'model', 'baseUrl', 'allowedDirs',
  'maxImageBytes', 'timeoutMs', 'maxTokens', 'maxImages', 'maxRetries',
  'debug', 'cache',
])

// Validates and normalizes a config object coming from the WebUI before it is
// persisted. This mirrors the same rules loadVisionConfig() enforces on read,
// so a value that passes here will also load cleanly later — preventing the
// "save succeeds, then every config read throws" foot-gun (e.g. cache.ttlMs=0,
// maxRetries=-1, or a malformed baseUrl). Throws Error on any invalid field.
export function normalizeConfigObject(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config must be a JSON object')
  }

  // Drop unknown keys first (prototype-pollution guard).
  const cleaned = {}
  for (const [key, value] of Object.entries(input)) {
    if (ALLOWED_CONFIG_KEYS.has(key)) cleaned[key] = value
  }

  // baseUrl: normalize exactly like loadVisionConfig does.
  if (typeof cleaned.baseUrl === 'string' && cleaned.baseUrl.trim()) {
    cleaned.baseUrl = normalizeBaseUrl(cleaned.baseUrl.trim(), 'baseUrl')
  } else if (cleaned.baseUrl !== undefined) {
    throw new Error('baseUrl must be a non-empty string')
  }

  // String fields: apiKey and model. loadVisionConfig reads these via
  // stringFromFile, which throws on null or non-string values. Reject such
  // values here too — otherwise saving {apiKey: null} succeeds but every
  // subsequent config read throws. apiKey may legitimately be empty (the user
  // is clearing it); model must not be empty.
  for (const key of ['apiKey', 'model']) {
    if (cleaned[key] !== undefined && cleaned[key] !== null) {
      if (typeof cleaned[key] !== 'string') {
        throw new Error(`config field "${key}" must be a string`)
      }
      const trimmed = cleaned[key].trim()
      if (key === 'model' && !trimmed) {
        throw new Error('config field "model" must not be empty')
      }
      cleaned[key] = trimmed
    } else if (cleaned[key] === null) {
      // null is never persisted for these — drop it so it can't reach the file.
      delete cleaned[key]
    }
  }

  // allowedDirs: accept array or comma-separated string -> normalized array.
  if (cleaned.allowedDirs !== undefined) {
    const list = Array.isArray(cleaned.allowedDirs)
      ? cleaned.allowedDirs
      : typeof cleaned.allowedDirs === 'string' ? cleaned.allowedDirs.split(',') : null
    if (!list) throw new Error('allowedDirs must be an array or comma-separated string')
    if (list.some((item) => typeof item !== 'string')) {
      throw new Error('allowedDirs entries must be strings')
    }
    cleaned.allowedDirs = list.map((item) => item.trim()).filter(Boolean)
  }

  // Numeric fields: reuse the same file loaders so the rules stay in sync.
  const numericFields = [
    { key: 'maxImageBytes', label: 'maxImageBytes', allowZero: false },
    { key: 'timeoutMs', label: 'timeoutMs', allowZero: false },
    { key: 'maxTokens', label: 'maxTokens', allowZero: false },
    { key: 'maxImages', label: 'maxImages', allowZero: false },
    { key: 'maxRetries', label: 'maxRetries', allowZero: true },
  ]
  for (const { key, label, allowZero } of numericFields) {
    if (cleaned[key] !== undefined && cleaned[key] !== null) {
      const validated = integerFromFile(cleaned[key], label, { allowZero })
      if (validated === undefined) {
        throw new Error(`config field "${label}" must be a ${allowZero ? 'non-negative' : 'positive'} integer`)
      }
      cleaned[key] = validated
      if (key === 'timeoutMs' && validated > MAX_REQUEST_TIMEOUT_MS) {
        throw new Error(`config field "timeoutMs" must not exceed ${MAX_REQUEST_TIMEOUT_MS}`)
      }
    }
  }

  // Booleans.
  for (const key of ['debug']) {
    if (cleaned[key] !== undefined && cleaned[key] !== null) {
      const value = booleanFromFile(cleaned[key], key)
      if (value === undefined) throw new Error(`config field "${key}" must be a boolean`)
      cleaned[key] = value
    }
  }

  // cache: validate nested structure using the same loaders as loadVisionConfig.
  if (cleaned.cache !== undefined && cleaned.cache !== null) {
    const rawCache = typeof cleaned.cache === 'object' && !Array.isArray(cleaned.cache) ? cleaned.cache : null
    if (!rawCache) throw new Error('config field "cache" must be an object')

    const out = {}
    if (rawCache.enabled !== undefined && rawCache.enabled !== null) {
      const enabled = booleanFromFile(rawCache.enabled, 'cache.enabled')
      if (enabled === undefined) throw new Error('config field "cache.enabled" must be a boolean')
      out.enabled = enabled
    }
    if (rawCache.maxEntries !== undefined && rawCache.maxEntries !== null) {
      const maxEntries = integerFromFile(rawCache.maxEntries, 'cache.maxEntries', { allowZero: true })
      if (maxEntries === undefined) throw new Error('config field "cache.maxEntries" must be a non-negative integer')
      out.maxEntries = maxEntries
    }
    if (rawCache.ttlMs !== undefined && rawCache.ttlMs !== null) {
      // ttlMs uses allowZero:false on purpose: 0 ttl means "instantly expire",
      // which makes the cache useless and is almost never what a user intends.
      const ttlMs = integerFromFile(rawCache.ttlMs, 'cache.ttlMs', { allowZero: false })
      if (ttlMs === undefined) throw new Error('config field "cache.ttlMs" must be a positive integer')
      out.ttlMs = ttlMs
    }
    cleaned.cache = out
  }

  return cleaned
}
