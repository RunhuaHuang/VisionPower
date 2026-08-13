import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync, lstatSync, statSync } from 'node:fs'
import { readdir, chmod, lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_VISION_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const DEFAULT_VISION_MODEL = 'qwen3-vl-flash'
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const DEFAULT_MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
export const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647
export const DEFAULT_MAX_TOKENS = 2048
export const DEFAULT_MAX_IMAGES = 8
export const DEFAULT_MAX_RETRIES = 2
export const DEFAULT_CACHE_MAX_ENTRIES = 32
export const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000
export const DEFAULT_INBOX_TTL_MS = 30 * 60 * 1000
export const DEFAULT_INBOX_MAX_ENTRIES = 64
// The Inbox persists browser uploads on disk, unlike maxTotalImageBytes which
// only caps one model request. Keep its default budget aligned with a normal
// request and put a separate hard ceiling on it so entry-count settings cannot
// turn a local upload bridge into unbounded disk consumption.
export const DEFAULT_INBOX_MAX_BYTES = 64 * 1024 * 1024
// Hard safety ceilings keep a malformed environment/config value from turning
// the WebUI request limit or image buffers into an effectively unbounded
// allocation. These are intentionally generous compared with the defaults.
export const MAX_CONFIG_IMAGE_BYTES = 256 * 1024 * 1024
export const MAX_CONFIG_TOTAL_IMAGE_BYTES = 512 * 1024 * 1024
export const MAX_CONFIG_TOKENS = 131_072
export const MAX_CONFIG_IMAGES = 64
export const MAX_CONFIG_RETRIES = 8
export const MAX_CONFIG_CACHE_ENTRIES = 10_000
export const MAX_CONFIG_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_CONFIG_INBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_CONFIG_INBOX_ENTRIES = 10_000
export const MAX_CONFIG_INBOX_BYTES = 512 * 1024 * 1024
const MAX_CONFIG_FILE_BYTES = 1024 * 1024
const MAX_API_KEY_BYTES = 16 * 1024
const MAX_MODEL_CHARS = 256

// Provider/model behavior belongs in one registry instead of being inferred by
// scattered error-string branches. Entries are ordered from most specific to
// most general. Unknown/custom endpoints intentionally remain `auto`: the
// request starts with the broadly-compatible OpenAI shape and keeps the narrow
// runtime fallbacks in vision-core.js as a compatibility safety net.
export const VISION_PROVIDER_CAPABILITIES = [
  {
    provider: 'openai', hosts: ['api.openai.com'], modelPattern: '^gpt-5', region: 'global',
    tokenParameter: 'max_completion_tokens', supportsSystemRole: true,
    auth: 'bearer', vision: true, supportsPublicImageUrl: true, lastVerified: '2026-08-11',
  },
  {
    provider: 'openai', hosts: ['api.openai.com'], region: 'global',
    tokenParameter: 'max_tokens', supportsSystemRole: true,
    auth: 'bearer', vision: true, supportsPublicImageUrl: true, lastVerified: null,
  },
  {
    provider: 'alibaba-cloud', hosts: ['dashscope.aliyuncs.com'], modelPattern: '^qwen3\\.(?:6|7)-', region: 'china',
    tokenParameter: 'max_completion_tokens', supportsSystemRole: true,
    auth: 'bearer', vision: true, supportsPublicImageUrl: true, lastVerified: '2026-08-11',
  },
  {
    provider: 'alibaba-cloud', hosts: ['dashscope.aliyuncs.com'], region: 'china',
    tokenParameter: 'max_tokens', supportsSystemRole: true,
    auth: 'bearer', vision: true, supportsPublicImageUrl: true, lastVerified: '2026-08-11',
  },
  {
    provider: 'minimax', hosts: ['api.minimaxi.com'], region: 'china',
    tokenParameter: 'max_completion_tokens', supportsSystemRole: true,
    auth: 'bearer', vision: true, supportsPublicImageUrl: true, lastVerified: '2026-08-11',
  },
  {
    provider: 'minimax', hosts: ['api.minimax.io'], region: 'global',
    tokenParameter: 'max_completion_tokens', supportsSystemRole: true,
    auth: 'bearer', vision: true, supportsPublicImageUrl: true, lastVerified: '2026-08-11',
  },
  {
    provider: 'minimax-gateway', hosts: ['api.prismaistudio.xyz'], region: 'custom',
    tokenParameter: 'auto', supportsSystemRole: 'auto',
    auth: 'bearer', vision: true, supportsPublicImageUrl: 'auto', lastVerified: null,
  },
  {
    provider: 'zhipu', hosts: ['open.bigmodel.cn'], region: 'china',
    tokenParameter: 'max_tokens', supportsSystemRole: true,
    auth: 'bearer', vision: true, supportsPublicImageUrl: true, lastVerified: null,
  },
  {
    provider: 'zhipu', hosts: ['api.z.ai'], region: 'global',
    tokenParameter: 'max_tokens', supportsSystemRole: true,
    auth: 'bearer', vision: true, supportsPublicImageUrl: true, lastVerified: null,
  },
  {
    provider: 'volcengine', hosts: ['ark.cn-beijing.volces.com'], region: 'china',
    tokenParameter: 'max_tokens', supportsSystemRole: true,
    auth: 'bearer', vision: true, supportsPublicImageUrl: true, lastVerified: null,
  },
  {
    provider: 'moonshot', hosts: ['api.moonshot.cn'], modelPattern: '^kimi-(?:k2\\.6|k2\\.7-code|k3)$', region: 'china',
    tokenParameter: 'max_tokens', supportsSystemRole: true,
    auth: 'bearer', vision: true, supportsPublicImageUrl: false,
    recommendedMaxTokens: 32_768, lastVerified: '2026-08-11',
  },
  {
    provider: 'moonshot', hosts: ['api.moonshot.ai'], modelPattern: '^kimi-(?:k2\\.6|k2\\.7-code|k3)$', region: 'global',
    tokenParameter: 'max_tokens', supportsSystemRole: true,
    auth: 'bearer', vision: true, supportsPublicImageUrl: false,
    recommendedMaxTokens: 32_768, lastVerified: '2026-08-11',
  },
  {
    provider: 'moonshot', hosts: ['api.moonshot.cn', 'api.moonshot.ai'], region: 'custom',
    tokenParameter: 'auto', supportsSystemRole: 'auto',
    auth: 'bearer', vision: 'auto', supportsPublicImageUrl: 'auto', lastVerified: null,
  },
  {
    provider: 'google', hosts: ['generativelanguage.googleapis.com'], region: 'global',
    tokenParameter: 'max_tokens', supportsSystemRole: true,
    auth: 'bearer', vision: true, supportsPublicImageUrl: true, lastVerified: null,
  },
]

export function resolveModelCapabilities(model, baseUrl) {
  let hostname = ''
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    // normalizeBaseUrl reports the actionable configuration error elsewhere.
  }
  const capability = VISION_PROVIDER_CAPABILITIES.find((entry) => {
    if (!entry.hosts.includes(hostname)) return false
    return !entry.modelPattern || new RegExp(entry.modelPattern, 'i').test(model)
  })
  if (capability) {
    return {
      provider: capability.provider,
      region: capability.region,
      tokenParameter: capability.tokenParameter,
      supportsSystemRole: capability.supportsSystemRole,
      auth: capability.auth,
      vision: capability.vision,
      supportsPublicImageUrl: capability.supportsPublicImageUrl ?? true,
      recommendedMaxTokens: capability.recommendedMaxTokens ?? null,
      lastVerified: capability.lastVerified,
    }
  }
  return {
    provider: 'custom',
    region: 'custom',
    tokenParameter: 'auto',
    supportsSystemRole: 'auto',
    auth: 'bearer',
    vision: 'auto',
    supportsPublicImageUrl: 'auto',
    recommendedMaxTokens: null,
    lastVerified: null,
  }
}

export const VISION_MODEL_PRESETS = [
  // —— 国内（China）端点 ——
  { model: 'qwen3-vl-flash', label: { zh: 'Qwen3-VL Flash (阿里云百炼)', en: 'Qwen3-VL Flash (Alibaba Cloud)' }, baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'qwen3-vl-plus', label: { zh: 'Qwen3-VL Plus (阿里云百炼)', en: 'Qwen3-VL Plus (Alibaba Cloud)' }, baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'qwen3.6-flash', label: { zh: 'Qwen3.6 Flash (阿里云百炼)', en: 'Qwen3.6 Flash (Alibaba Cloud)' }, baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'qwen3.7-flash', label: { zh: 'Qwen3.7 Flash (阿里云百炼)', en: 'Qwen3.7 Flash (Alibaba Cloud)' }, baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'qwen3.7-plus', label: { zh: 'Qwen3.7 Plus (阿里云百炼)', en: 'Qwen3.7 Plus (Alibaba Cloud)' }, baseUrl: DEFAULT_VISION_BASE_URL },
  { model: 'MiniMax-M3', label: { zh: 'MiniMax-M3 (国内)', en: 'MiniMax-M3 (China)' }, baseUrl: 'https://api.minimaxi.com/v1' },
  { model: 'MiniMax-M3', label: { zh: 'MiniMax-M3 (海外)', en: 'MiniMax-M3 (Global)' }, baseUrl: 'https://api.minimax.io/v1' },
  // 福利预设：通过第三方中转站提供，key 留空由作者私下分发（小红书等渠道），
  // 不对外公布获取入口。welfare:true 让 WebUI 隐藏官方「获取 API Key」链接。
  // 注意保持官方大小写 MiniMax-M3：该中转站的「福利」分组同样大小写敏感，
  // 写成全小写会 503「无可用渠道」。
  { model: 'MiniMax-M3', label: { zh: 'MiniMax-M3 (福利)', en: 'MiniMax-M3 (Welfare)' }, baseUrl: 'https://api.prismaistudio.xyz:663/v1', welfare: true },
  { model: 'glm-4.6v', label: { zh: 'GLM-4.6V (智谱 BigModel 国内)', en: 'GLM-4.6V (Zhipu China)' }, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { model: 'glm-4.6v', label: { zh: 'GLM-4.6V (智谱 Z.AI 海外)', en: 'GLM-4.6V (Zhipu Global)' }, baseUrl: 'https://api.z.ai/api/paas/v4' },
  { model: 'glm-5v-turbo', label: { zh: 'GLM-5V-Turbo (智谱 BigModel 国内)', en: 'GLM-5V-Turbo (Zhipu China)' }, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { model: 'glm-5v-turbo', label: { zh: 'GLM-5V-Turbo (智谱 Z.AI 海外)', en: 'GLM-5V-Turbo (Zhipu Global)' }, baseUrl: 'https://api.z.ai/api/paas/v4' },
  { model: 'doubao-seed-2-1-turbo-260628', label: { zh: 'Doubao Seed 2.1 Turbo (火山方舟)', en: 'Doubao Seed 2.1 Turbo (Volcengine Ark)' }, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { model: 'doubao-seed-2-0-lite-260428', label: { zh: 'Doubao Seed 2.0 Lite (火山方舟)', en: 'Doubao Seed 2.0 Lite (Volcengine Ark)' }, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { model: 'kimi-k2.6', label: { zh: 'Kimi K2.6 (月之暗面 国内)', en: 'Kimi K2.6 (Moonshot China)' }, baseUrl: 'https://api.moonshot.cn/v1', recommendedMaxTokens: 32_768 },
  { model: 'kimi-k2.6', label: { zh: 'Kimi K2.6 (月之暗面 海外)', en: 'Kimi K2.6 (Moonshot Global)' }, baseUrl: 'https://api.moonshot.ai/v1', recommendedMaxTokens: 32_768 },
  { model: 'kimi-k2.7-code', label: { zh: 'Kimi K2.7 Code (月之暗面 国内)', en: 'Kimi K2.7 Code (Moonshot China)' }, baseUrl: 'https://api.moonshot.cn/v1', recommendedMaxTokens: 32_768 },
  { model: 'kimi-k2.7-code', label: { zh: 'Kimi K2.7 Code (月之暗面 海外)', en: 'Kimi K2.7 Code (Moonshot Global)' }, baseUrl: 'https://api.moonshot.ai/v1', recommendedMaxTokens: 32_768 },
  { model: 'kimi-k3', label: { zh: 'Kimi K3 (月之暗面 国内)', en: 'Kimi K3 (Moonshot China)' }, baseUrl: 'https://api.moonshot.cn/v1', recommendedMaxTokens: 32_768 },
  { model: 'kimi-k3', label: { zh: 'Kimi K3 (月之暗面 海外)', en: 'Kimi K3 (Moonshot Global)' }, baseUrl: 'https://api.moonshot.ai/v1', recommendedMaxTokens: 32_768 },
  // —— 国际（International）端点 ——
  { model: 'gemini-3.6-flash', label: { zh: 'Gemini 3.6 Flash (Google)', en: 'Gemini 3.6 Flash (Google)' }, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { model: 'gpt-5.6', label: { zh: 'GPT-5.6 (OpenAI)', en: 'GPT-5.6 (OpenAI)' }, baseUrl: 'https://api.openai.com/v1' },
  { model: 'gpt-5.6-luna', label: { zh: 'GPT-5.6 Luna (OpenAI)', en: 'GPT-5.6 Luna (OpenAI)' }, baseUrl: 'https://api.openai.com/v1' },
  { model: 'gpt-4o', label: { zh: 'GPT-4o (OpenAI)', en: 'GPT-4o (OpenAI)' }, baseUrl: 'https://api.openai.com/v1' },
  { model: 'gpt-4o-mini', label: { zh: 'GPT-4o mini (OpenAI)', en: 'GPT-4o mini (OpenAI)' }, baseUrl: 'https://api.openai.com/v1' },
]

export function getDefaultBaseUrlForModel(model) {
  const matches = VISION_MODEL_PRESETS.filter((preset) => preset.model === model)
  // Never send a credential to an unrelated default provider. A few model IDs
  // intentionally appear more than once (China/global, plus optional gateways),
  // and an unknown custom model has no trustworthy provider inference at all.
  // The WebUI persists baseUrl alongside model, so this mainly protects manual
  // configs/env setups that forgot VISIONPOWER_BASE_URL.
  if (matches.length === 1) return matches[0].baseUrl
  if (model === DEFAULT_VISION_MODEL) return DEFAULT_VISION_BASE_URL

  const reason = matches.length > 1
    ? 'it is available through multiple configured endpoints'
    : 'its provider cannot be inferred safely'
  throw new Error(`VISIONPOWER_BASE_URL is required for model "${model}" because ${reason}`)
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

export function assertSafeApiKey(value, label = 'API key') {
  if (value && /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must not contain control characters`)
  }
  if (value && !/^[\x20-\x7e]+$/.test(value)) {
    throw new Error(`${label} must contain printable ASCII characters only`)
  }
  if (value && Buffer.byteLength(value, 'utf8') > MAX_API_KEY_BYTES) {
    throw new Error(`${label} must not exceed ${MAX_API_KEY_BYTES} bytes`)
  }
}

export function assertSafeModel(value, label = 'model') {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must not contain control characters`)
  }
  if (value.length > MAX_MODEL_CHARS) {
    throw new Error(`${label} must not exceed ${MAX_MODEL_CHARS} characters`)
  }
}

function parsePositiveInteger(envValue, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (!envValue.value) return fallback
  const trimmed = envValue.value
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${envValue.name} must be a positive integer`)
  }

  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${envValue.name} must be a positive integer`)
  }
  if (parsed > max) throw new Error(`${envValue.name} must not exceed ${max}`)

  return parsed
}

function parseNonNegativeInteger(envValue, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (!envValue.value) return fallback
  const trimmed = envValue.value
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${envValue.name} must be a non-negative integer`)
  }

  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${envValue.name} must be a non-negative integer`)
  }
  if (parsed > max) throw new Error(`${envValue.name} must not exceed ${max}`)

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

export function getInboxDir(env = process.env) {
  return resolve(env.VISIONPOWER_INBOX_DIR?.trim() || join(dirname(getConfigFilePath(env)), 'inbox'))
}

function isOwnedTempFileEntry(filePath, entry) {
  const prefix = `${basename(filePath)}.`
  const suffix = '.tmp'
  if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) return false
  const parts = entry.slice(prefix.length, -suffix.length).split('.')
  return parts.length === 2 && parts.every((part) => /^\d+$/.test(part))
}

// Best-effort sweep of orphaned temp files left by a prior write that was killed
// before it could rename. Only touches files matching this exact state file's
// temp pattern (statePath.<pid>.<ts>.tmp) and only if older than the threshold,
// so it never touches unrelated user files.
async function cleanupStaleStateTempFiles(statePath, maxAgeMs) {
  const dir = dirname(statePath)
  const now = Date.now()
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(entries.map(async (entry) => {
    if (!isOwnedTempFileEntry(statePath, entry)) return
    const tempPath = join(dir, entry)
    try {
      const fileStat = await lstat(tempPath)
      if (fileStat.isFile() && now - fileStat.mtimeMs > maxAgeMs) {
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
  const now = Date.now()
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!isOwnedTempFileEntry(filePath, entry)) continue
    const tempPath = join(dir, entry)
    try {
      const fileStat = lstatSync(tempPath)
      if (fileStat.isFile() && now - fileStat.mtimeMs > maxAgeMs) {
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
  let tempCreated = false
  try {
    await writeFile(tempPath, content, { mode: 0o600, flag: 'wx' })
    tempCreated = true
    await chmod(tempPath, 0o600)
    await rename(tempPath, statePath)
    // A fresh successful write is a safe moment to reap leftover temp files.
    await cleanupStaleStateTempFiles(statePath, 60 * 60 * 1000)
  } catch (error) {
    if (tempCreated) await unlink(tempPath).catch(() => {})
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
    const fileStat = statSync(configPath)
    if (!fileStat.isFile()) {
      throw new Error('path is not a regular file')
    }
    if (fileStat.size > MAX_CONFIG_FILE_BYTES) {
      throw new Error(`file exceeds the ${MAX_CONFIG_FILE_BYTES}-byte safety limit`)
    }
    raw = readFileSync(configPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`Could not read config file ${configPath}: ${error.message}`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Omit the underlying SyntaxError: V8's message echoes a slice of the file
    // content (e.g. `Unexpected token '-', "-----BEGIN OPENSSH P..."`), which
    // can leak sensitive bytes when VISIONPOWER_CONFIG is pointed at a non-JSON
    // private file. Surface a static description instead.
    throw new Error(`Invalid JSON in config file ${configPath}; ensure it contains a single JSON object`)
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

// `prefix` lets the WebUI PUT path (normalizeConfigObject) surface "config
// field" while loadVisionConfig keeps the historical "config file" wording.
function integerFromFile(value, label, { allowZero = false, max = Number.MAX_SAFE_INTEGER, prefix = 'config file' } = {}) {
  if (value === undefined || value === null) return undefined
  const valid = typeof value === 'number'
    && Number.isSafeInteger(value)
    && (allowZero ? value >= 0 : value > 0)
  if (!valid) {
    throw new Error(`${prefix} "${label}" must be a ${allowZero ? 'non-negative' : 'positive'} integer`)
  }
  if (value > max) throw new Error(`${prefix} "${label}" must not exceed ${max}`)
  return value
}

function booleanFromFile(value, label, { prefix = 'config file' } = {}) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`${prefix} "${label}" must be a boolean`)
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
  const configuredModel = readEnvValue(env, ['VISIONPOWER_MODEL']).value
    || modelFile.value
    || DEFAULT_VISION_MODEL
  assertSafeModel(configuredModel, 'VISIONPOWER_MODEL')

  const apiKeyFile = readFileStringValue(file, ['apiKey', 'VISIONPOWER_API_KEY', 'OPENAI_API_KEY'])
  const apiKey = readEnvValue(env, ['VISIONPOWER_API_KEY', 'OPENAI_API_KEY']).value
    || apiKeyFile.value
    || ''
  assertSafeApiKey(apiKey)

  const baseUrlEnv = readEnvValue(env, ['VISIONPOWER_BASE_URL'])
  const fileBaseUrl = readFileStringValue(file, ['baseUrl', 'VISIONPOWER_BASE_URL'])
  const rawBaseUrl = baseUrlEnv.value || fileBaseUrl.value || getDefaultBaseUrlForModel(configuredModel)
  const baseUrlSource = baseUrlEnv.value
    ? baseUrlEnv.name
    : fileBaseUrl.value ? fileBaseUrl.name : 'VISIONPOWER_BASE_URL'
  const baseUrl = normalizeBaseUrl(rawBaseUrl, baseUrlSource)
  const model = normalizeModelForKnownEndpoint(configuredModel, baseUrl)
  const modelCapabilities = resolveModelCapabilities(model, baseUrl)

  const allowedDirsEnv = readEnvValue(env, ['VISIONPOWER_ALLOWED_DIRS'])
  const debugEnv = readEnvValue(env, ['VISIONPOWER_DEBUG'])
  const timeoutEnv = readEnvValue(env, ['VISIONPOWER_TIMEOUT_MS'])
  const timeoutFile = integerFromFile(file.timeoutMs, 'timeoutMs')
  const requestTimeoutMs = parsePositiveInteger(timeoutEnv, timeoutFile ?? DEFAULT_REQUEST_TIMEOUT_MS)
  if (requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    const source = timeoutEnv.value ? timeoutEnv.name : 'config file "timeoutMs"'
    throw new Error(`${source} must not exceed ${MAX_REQUEST_TIMEOUT_MS}`)
  }

  const maxImageBytes = parsePositiveInteger(
    readEnvValue(env, ['VISIONPOWER_MAX_IMAGE_BYTES']),
    integerFromFile(file.maxImageBytes, 'maxImageBytes', { max: MAX_CONFIG_IMAGE_BYTES }) ?? DEFAULT_MAX_IMAGE_BYTES,
    MAX_CONFIG_IMAGE_BYTES,
  )

  const config = {
    apiKey,
    model,
    baseUrl,
    allowedDirs: allowedDirsEnv.value
      ? parseAllowedDirs(allowedDirsEnv)
      : (allowedDirsFromFile(file.allowedDirs) ?? []),
    maxImageBytes,
    maxTotalImageBytes: parsePositiveInteger(
      readEnvValue(env, ['VISIONPOWER_MAX_TOTAL_IMAGE_BYTES']),
      integerFromFile(file.maxTotalImageBytes, 'maxTotalImageBytes', { max: MAX_CONFIG_TOTAL_IMAGE_BYTES }) ?? DEFAULT_MAX_TOTAL_IMAGE_BYTES,
      MAX_CONFIG_TOTAL_IMAGE_BYTES,
    ),
    requestTimeoutMs,
    maxTokens: parsePositiveInteger(
      readEnvValue(env, ['VISIONPOWER_MAX_TOKENS']),
      integerFromFile(file.maxTokens, 'maxTokens', { max: MAX_CONFIG_TOKENS })
        ?? modelCapabilities.recommendedMaxTokens
        ?? DEFAULT_MAX_TOKENS,
      MAX_CONFIG_TOKENS,
    ),
    maxImages: parsePositiveInteger(
      readEnvValue(env, ['VISIONPOWER_MAX_IMAGES']),
      integerFromFile(file.maxImages, 'maxImages', { max: MAX_CONFIG_IMAGES }) ?? DEFAULT_MAX_IMAGES,
      MAX_CONFIG_IMAGES,
    ),
    maxRetries: parseNonNegativeInteger(
      readEnvValue(env, ['VISIONPOWER_MAX_RETRIES']),
      integerFromFile(file.maxRetries, 'maxRetries', { allowZero: true, max: MAX_CONFIG_RETRIES }) ?? DEFAULT_MAX_RETRIES,
      MAX_CONFIG_RETRIES,
    ),
    debug: debugEnv.value ? parseBoolean(debugEnv) : (booleanFromFile(file.debug, 'debug') ?? false),
    cache: resolveCacheConfig(env, file),
    inbox: {
      dir: getInboxDir(env),
      ttlMs: parsePositiveInteger(
        readEnvValue(env, ['VISIONPOWER_INBOX_TTL_MS']),
        integerFromFile(file.inboxTtlMs, 'inboxTtlMs', { max: MAX_CONFIG_INBOX_TTL_MS }) ?? DEFAULT_INBOX_TTL_MS,
        MAX_CONFIG_INBOX_TTL_MS,
      ),
      maxEntries: parsePositiveInteger(
        readEnvValue(env, ['VISIONPOWER_INBOX_MAX_ENTRIES']),
        integerFromFile(file.inboxMaxEntries, 'inboxMaxEntries', { max: MAX_CONFIG_INBOX_ENTRIES }) ?? DEFAULT_INBOX_MAX_ENTRIES,
        MAX_CONFIG_INBOX_ENTRIES,
      ),
      maxBytes: parsePositiveInteger(
        readEnvValue(env, ['VISIONPOWER_INBOX_MAX_BYTES']),
        integerFromFile(file.inboxMaxBytes, 'inboxMaxBytes', { max: MAX_CONFIG_INBOX_BYTES })
          ?? Math.max(DEFAULT_INBOX_MAX_BYTES, maxImageBytes),
        MAX_CONFIG_INBOX_BYTES,
      ),
    },
  }
  if (config.maxTotalImageBytes < config.maxImageBytes) {
    throw new Error('VISIONPOWER_MAX_TOTAL_IMAGE_BYTES must be greater than or equal to VISIONPOWER_MAX_IMAGE_BYTES')
  }
  if (config.inbox.maxBytes < config.maxImageBytes) {
    throw new Error('VISIONPOWER_INBOX_MAX_BYTES must be greater than or equal to VISIONPOWER_MAX_IMAGE_BYTES')
  }
  return config
}

function normalizeModelForKnownEndpoint(model, baseUrl) {
  if (model !== 'minimax-m3') return model
  const hostname = new URL(baseUrl).hostname.toLowerCase()
  if (['api.minimaxi.com', 'api.minimax.io', 'api.prismaistudio.xyz'].includes(hostname)) {
    return 'MiniMax-M3'
  }
  return model
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
  const maxEntriesFile = integerFromFile(file.cache?.maxEntries, 'cache.maxEntries', {
    allowZero: true,
    max: MAX_CONFIG_CACHE_ENTRIES,
  })
  const maxEntries = parseNonNegativeInteger(
    readEnvValue(env, ['VISIONPOWER_CACHE_MAX_ENTRIES']),
    maxEntriesFile ?? DEFAULT_CACHE_MAX_ENTRIES,
    MAX_CONFIG_CACHE_ENTRIES,
  )

  const ttlMsFile = integerFromFile(file.cache?.ttlMs, 'cache.ttlMs', {
    allowZero: false,
    max: MAX_CONFIG_CACHE_TTL_MS,
  })
  const ttlMs = parsePositiveInteger(
    readEnvValue(env, ['VISIONPOWER_CACHE_TTL_MS']),
    ttlMsFile ?? DEFAULT_CACHE_TTL_MS,
    MAX_CONFIG_CACHE_TTL_MS,
  )

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
  let tempCreated = false
  try {
    // `wx` prevents a pre-created symlink or file at the predictable temp path
    // from redirecting/overwriting the write when VISIONPOWER_CONFIG points at
    // a directory that is writable by another local user.
    writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    tempCreated = true
    renameSync(tmp, configPath)
    // A fresh successful write is a safe moment to reap leftover temp files
    // (e.g. from a prior save interrupted mid-write). Mirrors writeSkillStateFile.
    cleanupStaleTempFilesSync(configPath, 60 * 60 * 1000)
  } catch (error) {
    if (tempCreated) {
      try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    }
    throw error
  }
}

// Fields the WebUI is allowed to write into config.json. Unknown / prototype-
// polluting keys sent by the client are silently dropped. Kept here (next to
// the validators below) so the server and the validation pass always agree.
export const ALLOWED_CONFIG_KEYS = new Set([
  'apiKey', 'model', 'baseUrl', 'allowedDirs',
  'maxImageBytes', 'maxTotalImageBytes', 'timeoutMs', 'maxTokens', 'maxImages', 'maxRetries',
  'inboxTtlMs', 'inboxMaxEntries', 'inboxMaxBytes', 'debug', 'cache',
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
      if (key === 'apiKey') assertSafeApiKey(trimmed, 'config field "apiKey"')
      if (key === 'model') assertSafeModel(trimmed, 'config field "model"')
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
    { key: 'maxImageBytes', label: 'maxImageBytes', allowZero: false, max: MAX_CONFIG_IMAGE_BYTES },
    { key: 'maxTotalImageBytes', label: 'maxTotalImageBytes', allowZero: false, max: MAX_CONFIG_TOTAL_IMAGE_BYTES },
    { key: 'timeoutMs', label: 'timeoutMs', allowZero: false },
    { key: 'maxTokens', label: 'maxTokens', allowZero: false, max: MAX_CONFIG_TOKENS },
    { key: 'maxImages', label: 'maxImages', allowZero: false, max: MAX_CONFIG_IMAGES },
    { key: 'maxRetries', label: 'maxRetries', allowZero: true, max: MAX_CONFIG_RETRIES },
    { key: 'inboxTtlMs', label: 'inboxTtlMs', allowZero: false, max: MAX_CONFIG_INBOX_TTL_MS },
    { key: 'inboxMaxEntries', label: 'inboxMaxEntries', allowZero: false, max: MAX_CONFIG_INBOX_ENTRIES },
    { key: 'inboxMaxBytes', label: 'inboxMaxBytes', allowZero: false, max: MAX_CONFIG_INBOX_BYTES },
  ]
  for (const { key, label, allowZero, max } of numericFields) {
    if (cleaned[key] !== undefined && cleaned[key] !== null) {
      // integerFromFile only returns undefined for null/undefined (already
      // filtered above); any other invalid value throws directly, so the
      // "config field" message below can never be reached and was removed.
      cleaned[key] = integerFromFile(cleaned[key], label, { allowZero, max, prefix: 'config field' })
      if (key === 'timeoutMs' && cleaned[key] > MAX_REQUEST_TIMEOUT_MS) {
        throw new Error(`config field "timeoutMs" must not exceed ${MAX_REQUEST_TIMEOUT_MS}`)
      }
    }
  }

  // PUT /api/config replaces the persisted object rather than merging it with
  // the previous file. Validate omitted values against the defaults that the
  // next loadVisionConfig() call will actually apply; otherwise a partial PUT
  // such as {maxImageBytes: 100MB} could save successfully and immediately
  // poison every later config read because the default total cap is only 64MB.
  const effectiveMaxImageBytes = cleaned.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
  const effectiveMaxTotalImageBytes = cleaned.maxTotalImageBytes ?? DEFAULT_MAX_TOTAL_IMAGE_BYTES
  if (effectiveMaxTotalImageBytes < effectiveMaxImageBytes) {
    throw new Error('maxTotalImageBytes must be greater than or equal to maxImageBytes')
  }
  // Preserve an intuitive one-setting path: increasing a per-image limit
  // should not make a configuration invalid merely because the Inbox's
  // implicit default was smaller. An explicit Inbox budget still takes
  // precedence and must be large enough to store one permitted upload.
  const effectiveInboxMaxBytes = cleaned.inboxMaxBytes
    ?? Math.max(DEFAULT_INBOX_MAX_BYTES, effectiveMaxImageBytes)
  if (effectiveInboxMaxBytes < effectiveMaxImageBytes) {
    throw new Error('inboxMaxBytes must be greater than or equal to maxImageBytes')
  }

  // The same replacement semantics apply to model/baseUrl. A custom or
  // region-ambiguous model without a base URL would be accepted here but fail
  // on the very next read. Ask the shared resolver to prove that an omitted
  // endpoint can be inferred safely before persisting the object.
  if (cleaned.model !== undefined && cleaned.baseUrl === undefined) {
    getDefaultBaseUrlForModel(cleaned.model)
  }

  // Booleans.
  for (const key of ['debug']) {
    if (cleaned[key] !== undefined && cleaned[key] !== null) {
      cleaned[key] = booleanFromFile(cleaned[key], key, { prefix: 'config field' })
    }
  }

  // cache: validate nested structure using the same loaders as loadVisionConfig.
  if (cleaned.cache !== undefined && cleaned.cache !== null) {
    const rawCache = typeof cleaned.cache === 'object' && !Array.isArray(cleaned.cache) ? cleaned.cache : null
    if (!rawCache) throw new Error('config field "cache" must be an object')

    const out = {}
    if (rawCache.enabled !== undefined && rawCache.enabled !== null) {
      out.enabled = booleanFromFile(rawCache.enabled, 'cache.enabled', { prefix: 'config field' })
    }
    if (rawCache.maxEntries !== undefined && rawCache.maxEntries !== null) {
      out.maxEntries = integerFromFile(rawCache.maxEntries, 'cache.maxEntries', {
        allowZero: true,
        max: MAX_CONFIG_CACHE_ENTRIES,
        prefix: 'config field',
      })
    }
    if (rawCache.ttlMs !== undefined && rawCache.ttlMs !== null) {
      // ttlMs uses allowZero:false on purpose: 0 ttl means "instantly expire",
      // which makes the cache useless and is almost never what a user intends.
      out.ttlMs = integerFromFile(rawCache.ttlMs, 'cache.ttlMs', {
        allowZero: false,
        max: MAX_CONFIG_CACHE_TTL_MS,
        prefix: 'config field',
      })
    }
    cleaned.cache = out
  }

  return cleaned
}
