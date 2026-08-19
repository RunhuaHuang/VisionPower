import { createServer, request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { WEBUI_HTML } from './index-html.js'
import {
  loadVisionConfig,
  DEFAULT_VISION_MODEL,
  DEFAULT_MAX_TOKENS_HISTORY,
  DEFAULT_PROTOCOL,
  assertSafeApiKey,
  assertSafeModel,
  saveVisionConfig,
  getConfigFilePath,
  getDefaultBaseUrlForModel,
  normalizeBaseUrl,
  ensureAnthropicVersionPath,
  normalizeConfigObject,
  preserveUnknownConfigKeys,
  resolveModelCapabilities,
  VISION_MODEL_PRESETS,
  WELFARE_BASE_URL_ALIAS,
  resolveWelfareBaseUrl,
  maskWelfareBaseUrl,
} from '../config.js'
import { describeImage, normalizeBase64Image, testModelConnection } from '../vision-core.js'
import { deleteStagedImage, listStagedImages, stageImageBuffer } from '../image-inbox.js'
import { safeReadFileSync } from '../safe-fs.js'

const require = createRequire(import.meta.url)
let alpineScriptCache = null
const SMALL_JSON_BODY_LIMIT = 1024 * 1024
const JSON_BODY_OVERHEAD = 1024 * 1024

// Read the version once at module load and stamp it into the HTML template.
// The placeholder in index-html.js keeps the version single-sourced from
// package.json, so every release shows its real version in the WebUI header
// without a second edit.
const { version: webuiVersion } = require('../../package.json')
const indexHtml = WEBUI_HTML.replaceAll('__VISIONPOWER_VERSION__', webuiVersion)
const WEBUI_PRODUCT = 'visionpower'
const WEBUI_PROTOCOL_VERSION = 1

const HTML_CSP_BASE = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
]

let activeAnalysisRequests = 0
const MAX_ACTIVE_ANALYSIS_REQUESTS = 2

function isJsonMediaType(value) {
  const mediaType = String(value || '').split(';', 1)[0].trim().toLowerCase()
  return mediaType === 'application/json'
    || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType)
}

function requestAbortContext(req, res) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const abortOnEarlyClose = () => {
    if (!res.writableEnded) abort()
  }
  req.once('aborted', abort)
  res.once('close', abortOnEarlyClose)
  return {
    signal: controller.signal,
    cleanup() {
      req.removeListener('aborted', abort)
      res.removeListener('close', abortOnEarlyClose)
    },
  }
}

function readJsonBody(req, maxBytes = SMALL_JSON_BODY_LIMIT) {
  return new Promise((resolveReq, reject) => {
    const chunks = []
    let receivedBytes = 0
    let tooLarge = false
    req.on('data', (c) => {
      if (tooLarge) return
      receivedBytes += c.length
      if (receivedBytes > maxBytes) {
        tooLarge = true
        chunks.length = 0
        // Stop accepting the rest of an oversized upload instead of letting a
        // peer stream indefinitely: give the 413 response a tick to flush,
        // then drop the connection.
        setImmediate(() => req.destroy())
        const error = new Error(`Request body too large (max ${maxBytes} bytes)`)
        error.statusCode = 413
        reject(error)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (tooLarge) return
      try {
        const raw = Buffer.concat(chunks).toString('utf-8')
        const parsed = raw ? JSON.parse(raw) : {}
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const error = new Error('Request body must be a JSON object')
          error.statusCode = 400
          reject(error)
          return
        }
        resolveReq(parsed)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  setCommonSecurityHeaders(res)
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendText(res, status, body, contentType) {
  setCommonSecurityHeaders(res)
  res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate')
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function setCommonSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
}

function embeddingOrigin(requestUrl) {
  try {
    const url = new URL(requestUrl || '/', 'http://127.0.0.1')
    if (url.searchParams.get('embed') !== 'dsh') return null
    const candidate = new URL(url.searchParams.get('parentOrigin') || '')
    if (candidate.protocol !== 'http:' || !isLoopbackAuthority(candidate.host)) return null
    return candidate.origin
  } catch {
    return null
  }
}

function setHtmlSecurityHeaders(res, requestUrl) {
  setCommonSecurityHeaders(res)
  const frameAncestor = embeddingOrigin(requestUrl) ?? "'none'"
  res.setHeader('Content-Security-Policy', [...HTML_CSP_BASE, `frame-ancestors ${frameAncestor}`].join('; '))
  res.setHeader('Cache-Control', 'no-store')
}

function loadAlpineScript() {
  if (!alpineScriptCache) {
    alpineScriptCache = readFileSync(require.resolve('alpinejs/dist/cdn.min.js'), 'utf-8')
  }
  return alpineScriptCache
}

function stripPort(authority) {
  return (authority || '').replace(/^\[/, '').replace(/\]$/, '').split(':')[0]?.toLowerCase() ?? ''
}

function getPort(authority) {
  const parts = (authority || '').replace(/^\[/, '').replace(/\]$/, '').split(':')
  return parts.length > 1 ? parts.at(-1) : ''
}

function isLoopbackAuthority(authority) {
  if (!authority) return false
  const host = stripPort(authority)
  return host === '127.0.0.1' || host === 'localhost'
}

function validateLocalApiRequest(meta) {
  if (!isLoopbackAuthority(meta.host)) return 'Host must be 127.0.0.1 or localhost'

  if (meta.origin) {
    try {
      const originUrl = new URL(meta.origin)
      const hostPort = getPort(meta.host)
      const originPort = originUrl.port || (originUrl.protocol === 'https:' ? '443' : '80')
      if (!isLoopbackAuthority(originUrl.host) || originPort !== hostPort) {
        return 'Origin does not match local WebUI address'
      }
    } catch {
      return 'Invalid Origin'
    }
  }

  if (meta.secFetchSite && !['same-origin', 'none'].includes(meta.secFetchSite)) {
    return 'Cross-origin API request rejected'
  }

  const method = meta.method.toUpperCase()
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (!isJsonMediaType(meta.contentType)) return 'Write request must be JSON'
  }

  return null
}

function validateIncomingApiRequest(req, method) {
  const header = (name) => {
    const value = req.headers[name.toLowerCase()]
    return Array.isArray(value) ? value[0] : value
  }
  return validateLocalApiRequest({
    method,
    host: header('host'),
    origin: header('origin'),
    secFetchSite: header('sec-fetch-site'),
    contentType: header('content-type'),
  })
}

function maskApiKey(key) {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

// Shared "masked echo means keep" credential rules for PUT /api/config and
// POST /api/test-connection. Both routes treat a displayed mask as
// presentation data, not a protocol sentinel: only an explicit preserve
// signal may substitute a saved credential, a new literal always wins when
// preservation is off, and a kept credential never crosses a Base URL
// boundary. One implementation keeps the two routes' rules from drifting.
// Returns the effective key ('' means no key).
function resolveApiKeyChoice({
  echoed = '',
  echoedDefined = false,
  preserve = false,
  sameScope = false,
  keepKeys = [],
  keepWhenUnspecified = '',
}) {
  const masks = keepKeys.filter(Boolean).map(maskApiKey)
  if (preserve) {
    if (echoed && !masks.includes(echoed)) {
      throw new Error('preserveConfiguredKey cannot be combined with a new API key')
    }
    const keep = keepKeys.find(Boolean) || ''
    return sameScope ? keep : ''
  }
  if (echoed) return echoed
  if (echoedDefined) return ''
  return keepWhenUnspecified
}

function loadRawConfig() {
  const configPath = getConfigFilePath()
  let raw
  try {
    raw = safeReadFileSync(configPath, {
      maxBytes: SMALL_JSON_BODY_LIMIT,
      label: 'config file',
    }).toString('utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`Could not safely read the existing config file: ${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('The existing config file contains invalid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The existing config file must contain a JSON object')
  }
  return parsed
}

function rawApiKey(config) {
  for (const key of ['apiKey', 'VISIONPOWER_API_KEY', 'OPENAI_API_KEY']) {
    if (typeof config[key] === 'string' && config[key].trim()) return config[key].trim()
  }
  return ''
}

function sameNormalizedBaseUrl(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false
  try {
    // The bare official Anthropic host and its /v1 form are the same endpoint;
    // normalize both sides so a switch between them never counts as a
    // credential-scope change. Other hosts are unaffected (no-op).
    return ensureAnthropicVersionPath(normalizeBaseUrl(left, 'baseUrl', { allowInsecureHttp: true }), 'anthropic')
      === ensureAnthropicVersionPath(normalizeBaseUrl(right, 'baseUrl', { allowInsecureHttp: true }), 'anthropic')
  } catch {
    return false
  }
}

// A config PUT replaces the file rather than merging into it. Work out the
// endpoint the replacement file will use on its own (without process-level
// environment overrides) before deciding whether a persisted credential may
// remain attached to it.
function getReplacementConfigBaseUrl(config) {
  const model = config.model ?? DEFAULT_VISION_MODEL
  return normalizeBaseUrl(config.baseUrl ?? getDefaultBaseUrlForModel(model), 'baseUrl', {
    allowInsecureHttp: config.allowInsecureHttp ?? false,
  })
}

function loadFileOnlyVisionConfig() {
  // Preserve only VISIONPOWER_CONFIG so this read reflects the credential's
  // saved scope rather than an API key, model, or endpoint supplied by the
  // process environment.
  return loadVisionConfig({ VISIONPOWER_CONFIG: getConfigFilePath() })
}

function getWebuiConfig() {
  const effective = loadVisionConfig()
  const raw = loadRawConfig()
  const savedApiKey = rawApiKey(raw)
  return {
    ...effective,
    requestTimeoutMs: undefined,
    inbox: undefined,
    // The cache mirror's on-disk location is server-side plumbing, just like
    // the inbox dir; expose only the user-tunable cache knobs.
    cache: {
      enabled: effective.cache.enabled,
      maxEntries: effective.cache.maxEntries,
      ttlMs: effective.cache.ttlMs,
    },
    timeoutMs: effective.requestTimeoutMs,
    inboxTtlMs: effective.inbox.ttlMs,
    inboxMaxEntries: effective.inbox.maxEntries,
    inboxMaxBytes: effective.inbox.maxBytes,
    // Keep the persisted file key editable without ever returning it in full.
    // If an environment key overrides it, the connection-test path still uses
    // the effective key from loadVisionConfig() when the mask is echoed back.
    apiKey: savedApiKey ? maskApiKey(savedApiKey) : '',
    apiKeyConfigured: Boolean(effective.apiKey),
    // The welfare gateway endpoint is private: clients only see the alias.
    baseUrl: maskWelfareBaseUrl(effective.baseUrl),
    protocol: effective.protocol ?? DEFAULT_PROTOCOL,
  }
}

function maxPlaygroundBodyBytes(config) {
  // Base64 expands bytes by roughly 4/3. Leave bounded room for JSON syntax,
  // prompt text, and MIME metadata so the HTTP layer honors maxImageBytes.
  return Math.ceil(config.maxImageBytes / 3) * 4 + JSON_BODY_OVERHEAD
}

async function handleApi(method, url, req, res) {
  // `url` is already the query-stripped pathname (computed once by the
  // request handler below); /api/export reads req.url for its parameters.
  const pathname = url

  // A loopback port being open is not sufficient proof that it belongs to
  // this VisionPower instance. dsh and setup-dsh use this identity document
  // before reusing an existing listener.
  if (method === 'GET' && pathname === '/api/identity') {
    sendJson(res, 200, {
      product: WEBUI_PRODUCT,
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      version: webuiVersion,
      configPath: getConfigFilePath(),
      pid: process.pid,
    })
    return true
  }

  // GET /api/config
  if (method === 'GET' && pathname === '/api/config') {
    sendJson(res, 200, getWebuiConfig())
    return true
  }

  // PUT /api/config
  if (method === 'PUT' && pathname === '/api/config') {
    try {
      const body = await readJsonBody(req)
      const { preserveConfiguredKey = false, ...configInput } = body
      if (typeof preserveConfiguredKey !== 'boolean') {
        sendJson(res, 400, { error: 'preserveConfiguredKey must be a boolean' })
        return true
      }
      const current = loadRawConfig()

      // Resolve the private welfare alias to the real endpoint before
      // validation/persistence — the browser never learns the real URL.
      if (typeof configInput.baseUrl === 'string') {
        configInput.baseUrl = resolveWelfareBaseUrl(configInput.baseUrl, configInput.model)
      }

      // Validate + normalize using the same rules loadVisionConfig enforces on
      // read. This drops unknown keys (prototype-pollution guard) and rejects
      // poison values (e.g. cache.ttlMs=0) before they can be persisted — a
      // bad value here would make every subsequent config read throw.
      const cleaned = normalizeConfigObject(configInput)

      // dshEnabled has its own immediate PATCH endpoint. A full-form save may
      // carry a stale browser snapshot, so it must never change this lifecycle
      // preference. Preserve/migrate the raw saved value independently.
      const savedDshEnabled = typeof current.dshEnabled === 'boolean'
        ? current.dshEnabled
        : (typeof current.enabled === 'boolean' ? current.enabled : undefined)
      delete cleaned.dshEnabled
      if (savedDshEnabled !== undefined) cleaned.dshEnabled = savedDshEnabled

      // The rendered mask is presentation data, not a protocol sentinel: a
      // legitimate printable API key can equal e.g. `abcd****wxyz`. Preserve
      // only when the client explicitly asks us to, so an edited literal is
      // never silently replaced with the old credential.
      const savedApiKey = rawApiKey(current)
      if (preserveConfiguredKey) {
        // Mask-intent rules first (shared with /api/test-connection), then the
        // PUT-specific scope checks with their actionable messages.
        resolveApiKeyChoice({ echoed: cleaned.apiKey ?? '', preserve: true, keepKeys: [savedApiKey] })
        const effectiveCurrent = loadVisionConfig()
        const replacementBaseUrl = getReplacementConfigBaseUrl(cleaned)
        if (!sameNormalizedBaseUrl(replacementBaseUrl, effectiveCurrent.baseUrl)) {
          throw new Error('The configured API key cannot be preserved after changing Base URL; enter the full API key')
        }
        if (savedApiKey) {
          const savedConfig = loadFileOnlyVisionConfig()
          if (!sameNormalizedBaseUrl(replacementBaseUrl, savedConfig.baseUrl)) {
            throw new Error('The persisted API key cannot be preserved because the Base URL differs from its saved configuration; enter the full API key')
          }
          cleaned.apiKey = savedApiKey
        } else {
          delete cleaned.apiKey
        }
      }

      // The form snapshot only owns the fields this version knows; keys the
      // persisted file holds beyond that set survive the save verbatim.
      saveVisionConfig(preserveUnknownConfigKeys(cleaned, current))

      const masked = { ...cleaned, baseUrl: maskWelfareBaseUrl(cleaned.baseUrl) }
      if (cleaned.apiKey) {
        masked.apiKey = maskApiKey(cleaned.apiKey)
      }
      sendJson(res, 200, { ok: true, config: masked })
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message })
    }
    return true
  }

  // PATCH /api/config/dsh-enabled
  // The dsh lifecycle switch is intentionally independent from the full config
  // form. Toggling it must not commit unsaved model/API-key drafts from the
  // browser, so update exactly one persisted field while preserving the raw
  // owner-controlled config (including legacy env-style aliases).
  if (method === 'PATCH' && pathname === '/api/config/dsh-enabled') {
    try {
      const body = await readJsonBody(req)
      if (body === null || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || typeof body.dshEnabled !== 'boolean') {
        sendJson(res, 400, { error: 'dshEnabled must be the only field and must be a boolean' })
        return true
      }

      // Refuse to rewrite a malformed/unloadable file as an empty config.
      const effectiveBefore = loadVisionConfig()
      if (String(process.env.VISIONPOWER_DSH_ENABLED ?? '').trim()) {
        sendJson(res, 409, {
          error: 'VISIONPOWER_DSH_ENABLED overrides the saved dsh switch',
          dshEnabled: effectiveBefore.dshEnabled !== false,
        })
        return true
      }
      const current = loadRawConfig()
      const next = Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== 'enabled' && key !== 'dshEnabled'),
      )
      next.dshEnabled = body.dshEnabled
      saveVisionConfig(next)

      const effective = loadVisionConfig()
      sendJson(res, 200, { ok: true, dshEnabled: effective.dshEnabled !== false })
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message })
    }
    return true
  }

  // GET /api/presets
  if (method === 'GET' && pathname === '/api/presets') {
    // The welfare preset's real endpoint never leaves the process; clients
    // match/select it via the public alias instead.
    sendJson(res, 200, VISION_MODEL_PRESETS.map((p) => (
      p.welfare ? { ...p, baseUrl: WELFARE_BASE_URL_ALIAS } : p
    )))
    return true
  }

  // GET /api/status
  if (method === 'GET' && pathname === '/api/status') {
    const config = loadVisionConfig()
    sendJson(res, 200, {
      dshEnabled: config.dshEnabled !== false,
      ready: Boolean(config.apiKey),
      configPath: getConfigFilePath(),
    })
    return true
  }

  // Browser-to-agent attachment bridge. The WebUI may stage only bytes the
  // browser explicitly uploaded; it cannot ask the server to read a path.
  if (method === 'GET' && pathname === '/api/inbox') {
    try {
      const config = loadVisionConfig()
      const items = await listStagedImages(config)
      sendJson(res, 200, {
        items,
        ttlMs: config.inbox.ttlMs,
        maxEntries: config.inbox.maxEntries,
      })
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message })
    }
    return true
  }

  if (method === 'POST' && pathname === '/api/inbox') {
    try {
      const config = loadVisionConfig()
      const body = await readJsonBody(req, maxPlaygroundBodyBytes(config))
      const unknownKey = Object.keys(body).find((key) => !['image_base64', 'image_mime_type'].includes(key))
      if (unknownKey) {
        sendJson(res, 400, { error: `Inbox request contains an unknown field: ${unknownKey}` })
        return true
      }
      if (typeof body.image_base64 !== 'string' || !body.image_base64.trim()) {
        sendJson(res, 400, { error: 'Provide image_base64 to stage an image' })
        return true
      }
      const image = normalizeBase64Image(body.image_base64, body.image_mime_type, config)
      const item = await stageImageBuffer(image.data, image.mimeType, config)
      sendJson(res, 201, { item })
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message })
    }
    return true
  }

  if (method === 'DELETE' && pathname.startsWith('/api/inbox/')) {
    try {
      const imageRef = decodeURIComponent(pathname.slice('/api/inbox/'.length))
      const removed = await deleteStagedImage(imageRef, loadVisionConfig())
      if (!removed) {
        sendJson(res, 404, { error: 'image_ref does not exist or has expired' })
      } else {
        sendJson(res, 200, { ok: true })
      }
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message })
    }
    return true
  }

  // POST /api/test
  if (method === 'POST' && pathname === '/api/test') {
    if (activeAnalysisRequests >= MAX_ACTIVE_ANALYSIS_REQUESTS) {
      res.setHeader('Retry-After', '1')
      sendJson(res, 429, { error: 'Too many active analysis requests' })
      return true
    }
    activeAnalysisRequests += 1
    const abortContext = requestAbortContext(req, res)
    try {
      const config = loadVisionConfig()
      const body = await readJsonBody(req, maxPlaygroundBodyBytes(config))

      const allowedKeys = new Set([
        'image_url', 'image_base64', 'image_ref', 'image_mime_type', 'prompt', 'output_format',
      ])
      const unknownKey = Object.keys(body).find((key) => !allowedKeys.has(key))
      if (unknownKey) {
        sendJson(res, 400, { error: `Playground request contains an unknown field: ${unknownKey}` })
        return true
      }
      for (const key of ['image_url', 'image_base64', 'image_ref', 'prompt']) {
        if (body[key] !== undefined && typeof body[key] !== 'string') {
          sendJson(res, 400, { error: `${key} must be a string` })
          return true
        }
      }
      if (body.image_mime_type !== undefined && typeof body.image_mime_type !== 'string') {
        sendJson(res, 400, { error: 'image_mime_type must be a string' })
        return true
      }
      
      // Playground accepts URL, base64, and opaque Inbox references — image_path is explicitly
      // blocked here because the playground runs in a browser context and must
      // not be used to read arbitrary local files on the server.
      const params = { prompt: body.prompt ?? 'Describe this image.' }
      if (body.output_format !== undefined) {
        params.output_format = body.output_format
      }
      const sourceKeys = ['image_url', 'image_base64', 'image_ref']
        .filter((key) => typeof body[key] === 'string' && body[key].trim())
      if (sourceKeys.length !== 1) {
        sendJson(res, 400, { error: 'Provide exactly one of image_url, image_base64, or image_ref' })
        return true
      }
      if (body.image_mime_type !== undefined && sourceKeys[0] !== 'image_base64') {
        sendJson(res, 400, { error: 'image_mime_type can only be used with image_base64' })
        return true
      }
      if (typeof body.image_ref === 'string' && body.image_ref) {
        params.image_ref = body.image_ref.trim()
      } else if (typeof body.image_url === 'string' && body.image_url) {
        params.image_url = body.image_url.trim()
      } else if (typeof body.image_base64 === 'string' && body.image_base64) {
        params.image_base64 = body.image_base64
        if (typeof body.image_mime_type === 'string') {
          params.image_mime_type = body.image_mime_type
        }
      }

      const result = await describeImage(params, config, abortContext.signal)
      sendJson(res, 200, { result })
    } catch (err) {
      if (!res.writableEnded) sendJson(res, err.statusCode || 400, { error: err.message })
    } finally {
      abortContext.cleanup()
      activeAnalysisRequests -= 1
    }
    return true
  }

  // POST /api/test-connection
  if (method === 'POST' && pathname === '/api/test-connection') {
    if (activeAnalysisRequests >= MAX_ACTIVE_ANALYSIS_REQUESTS) {
      res.setHeader('Retry-After', '1')
      sendJson(res, 429, { error: 'Too many active analysis requests' })
      return true
    }
    activeAnalysisRequests += 1
    const abortContext = requestAbortContext(req, res)
    try {
      const body = await readJsonBody(req)
      const unknownKey = Object.keys(body).find((key) => !['apiKey', 'baseUrl', 'model', 'protocol', 'allowInsecureHttp', 'testVision', 'preserveConfiguredKey'].includes(key))
      if (unknownKey) {
        sendJson(res, 400, { error: `Connection test contains an unknown field: ${unknownKey}` })
        return true
      }
      for (const key of ['apiKey', 'baseUrl', 'model', 'protocol']) {
        if (body[key] !== undefined && typeof body[key] !== 'string') {
          sendJson(res, 400, { error: `${key} must be a string` })
          return true
        }
      }
      if (body.protocol !== undefined && !['openai', 'anthropic'].includes(body.protocol)) {
        sendJson(res, 400, { error: 'protocol must be "openai" or "anthropic"' })
        return true
      }
      if (body.testVision !== undefined && typeof body.testVision !== 'boolean') {
        sendJson(res, 400, { error: 'testVision must be a boolean' })
        return true
      }
      if (body.allowInsecureHttp !== undefined && typeof body.allowInsecureHttp !== 'boolean') {
        sendJson(res, 400, { error: 'allowInsecureHttp must be a boolean' })
        return true
      }
      if (body.preserveConfiguredKey !== undefined && typeof body.preserveConfiguredKey !== 'boolean') {
        sendJson(res, 400, { error: 'preserveConfiguredKey must be a boolean' })
        return true
      }
      const apiKeyInput = body.apiKey?.trim() ?? ''
      // Accept the welfare alias from the WebUI and resolve it server-side so
      // a connection probe never requires the client to know the real URL.
      const baseUrlInput = resolveWelfareBaseUrl(body.baseUrl?.trim() ?? '', body.model)
      const modelInput = body.model?.trim() ?? ''
      if (body.baseUrl !== undefined && !baseUrlInput) {
        sendJson(res, 400, { error: 'baseUrl must not be empty' })
        return true
      }
      if (body.model !== undefined && !modelInput) {
        sendJson(res, 400, { error: 'model must not be empty' })
        return true
      }
      try {
        assertSafeApiKey(apiKeyInput)
        if (modelInput) assertSafeModel(modelInput)
      } catch (err) {
        sendJson(res, 400, { error: err.message })
        return true
      }
      const current = loadVisionConfig()
      
      const tempConfig = {
        ...current,
        requestTimeoutMs: current.requestTimeoutMs || 60000,
      }

      if (baseUrlInput) {
        tempConfig.baseUrl = baseUrlInput
      }
      if (modelInput) {
        tempConfig.model = modelInput
      }
      if (body.protocol) {
        tempConfig.protocol = body.protocol
      }
      if (body.allowInsecureHttp !== undefined) {
        tempConfig.allowInsecureHttp = body.allowInsecureHttp
      }

      // Normalize before deciding whether a masked/omitted key may be reused.
      // A trailing slash is harmless, but a changed endpoint is a different
      // credential scope and must never receive the key saved for the old one.
      try {
        tempConfig.baseUrl = normalizeBaseUrl(tempConfig.baseUrl, 'baseUrl', {
          allowInsecureHttp: tempConfig.allowInsecureHttp ?? false,
        })
      } catch (err) {
        sendJson(res, 400, { error: err.message })
        return true
      }
      const sameBaseUrl = sameNormalizedBaseUrl(tempConfig.baseUrl, current.baseUrl)

      // The WebUI carries explicit preservation intent; resolveApiKeyChoice
      // holds the shared mask/new-literal/scope rules (also used by
      // PUT /api/config). The kept credential is always the effective key
      // from loadVisionConfig(): a file key may coexist with an
      // OPENAI_API_KEY env key, and the env key is what the running server
      // actually uses when preservation was requested.
      try {
        tempConfig.apiKey = resolveApiKeyChoice({
          echoed: apiKeyInput,
          echoedDefined: body.apiKey !== undefined,
          preserve: body.preserveConfiguredKey === true,
          sameScope: sameBaseUrl,
          keepKeys: [current.apiKey, rawApiKey(loadRawConfig())],
          keepWhenUnspecified: sameBaseUrl ? current.apiKey : '',
        })
      } catch (err) {
        sendJson(res, 400, { error: err.message })
        return true
      }

      if (!tempConfig.apiKey) {
        sendJson(res, 400, { error: 'API key is required for testing' })
        return true
      }

      // A model selected in the WebUI may differ from the model currently
      // persisted on disk. If the current budget is still the global default,
      // honor a provider-specific recommended budget for the temporary probe
      // (notably Kimi reasoning models, which can spend 2048 tokens on hidden
      // reasoning and emit no visible answer). An explicit non-default user
      // budget remains untouched.
      const probeCapabilities = resolveModelCapabilities(tempConfig.model, tempConfig.baseUrl)
      if (DEFAULT_MAX_TOKENS_HISTORY.includes(tempConfig.maxTokens) && probeCapabilities.recommendedMaxTokens) {
        tempConfig.maxTokens = probeCapabilities.recommendedMaxTokens
      }

      const connectionResult = await testModelConnection(tempConfig, {
        testVision: body.testVision !== false,
        signal: abortContext.signal,
      })
      sendJson(res, 200, {
        ok: true,
        message: connectionResult.message,
        visionVerified: connectionResult.visionVerified,
        reason: connectionResult.reason,
      })
    } catch (err) {
      if (!res.writableEnded) sendJson(res, err.statusCode || 400, { error: err.message })
    } finally {
      abortContext.cleanup()
      activeAnalysisRequests -= 1
    }
    return true
  }

  // GET /api/export?agent=claude
  if (method === 'GET' && pathname === '/api/export') {
    const u = new URL(req.url || '/', 'http://localhost')
    const agent = u.searchParams.get('agent') || 'claude'

    // Always export the published npx form — this is what installed users run.
    // The local dev path (src/index.js) is never useful to copy into a host config.
    const serverEntry = {
      command: 'npx',
      args: ['-y', '--package', `visionpower@${webuiVersion}`, 'visionpower'],
    }

    let result
    if (agent === 'claude') {
      result = {
        note: 'Copy this snippet into your Claude Desktop config file (~/Library/Application Support/Claude/claude_desktop_config.json)',
        config: {
          mcpServers: {
            'visionpower': serverEntry,
          },
        },
      }
    } else if (agent === 'cursor') {
      result = {
        note: 'Add a new "command" MCP server in Cursor Settings → MCP. Use the config below:',
        config: {
          mcpServers: {
            'visionpower': serverEntry,
          },
        },
      }
    } else {
      result = {
        note: 'Add this server block to your MCP client config file:',
        config: {
          mcpServers: {
            'visionpower': serverEntry,
          },
        },
      }
    }
    sendJson(res, 200, result)
    return true
  }

  return false
}

export function startWebuiServer(port, options = {}) {
  return new Promise((resolveStart, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const method = req.method || 'GET'
        // Strip the query once for route matching so cache-busting or proxy
        // parameters never turn a valid endpoint into a 404. handleApi gets
        // this pathname; /api/export reads the full URL for its parameters.
        const pathname = (req.url || '/').split('?')[0]

        if (method === 'OPTIONS') {
          setCommonSecurityHeaders(res)
          res.writeHead(204)
          res.end()
          return
        }

        if (pathname.startsWith('/api/')) {
          const apiError = validateIncomingApiRequest(req, method)
          if (apiError) {
            sendJson(res, 403, { error: apiError })
            return
          }
          const handled = await handleApi(method, pathname, req, res)
          if (!handled) sendJson(res, 404, { error: 'Not Found' })
          return
        }

        if (method === 'GET' && pathname === '/assets/alpine.min.js') {
          sendText(res, 200, loadAlpineScript(), 'text/javascript; charset=utf-8')
          return
        }

        if (pathname === '/' || pathname === '/index.html') {
          setHtmlSecurityHeaders(res, req.url)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(indexHtml)
          return
        }

        sendJson(res, 404, { error: 'Not Found' })
      } catch (err) {
        // Avoid echoing internal error details (filesystem paths, upstream
        // fragments, stack traces) back to the HTTP client. Log the real error
        // locally for the operator and return a fixed message instead. Per-route
        // catches above still surface actionable 4xx messages from err.message.
        process.stderr.write(`[visionpower] WebUI internal error: ${err?.stack ?? err}\n`)
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'Internal server error' })
        }
      }
    })

    server.on('error', reject)
    server.requestTimeout = 65_000
    server.headersTimeout = 10_000
    server.keepAliveTimeout = 5_000
    server.maxRequestsPerSocket = 100

    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const actualPort = address && typeof address === 'object' ? address.port : port
      const url = `http://127.0.0.1:${actualPort}`
      process.stderr.write(`\n[visionpower] WebUI started at: ${url}\n`)
      process.stderr.write(`[visionpower] Config file: ${getConfigFilePath()}\n`)
      process.stderr.write(`[visionpower] Press Ctrl+C to stop\n\n`)
      
      const shouldOpenBrowser = options.openBrowser ?? process.env.VISIONPOWER_NO_OPEN !== '1'
      if (shouldOpenBrowser) {
        openBrowser(url).catch(() => {})
      }
      resolveStart(server)
    })
  })
}

export function probeWebuiServer(port, {
  timeoutMs = 1500,
  expectedVersion = webuiVersion,
  expectedConfigPath = getConfigFilePath(),
} = {}) {
  return new Promise((resolveProbe, rejectProbe) => {
    const fail = (message, cause) => {
      const error = new Error(message, cause ? { cause } : undefined)
      error.code = 'VISIONPOWER_WEBUI_CONFLICT'
      rejectProbe(error)
    }
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/identity',
      method: 'GET',
      headers: { Accept: 'application/json', Host: `127.0.0.1:${port}` },
    }, (res) => {
      const chunks = []
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 64 * 1024) {
          req.destroy(new Error('identity response is too large'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          fail(`Port ${port} returned HTTP ${res.statusCode ?? 'unknown'} instead of a VisionPower identity document`)
          return
        }
        let identity
        try {
          identity = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch (error) {
          fail(`Port ${port} did not return valid VisionPower identity JSON`, error)
          return
        }
        if (identity?.product !== WEBUI_PRODUCT || identity?.protocolVersion !== WEBUI_PROTOCOL_VERSION) {
          fail(`Port ${port} is occupied by an incompatible service`)
          return
        }
        if (expectedVersion && identity.version !== expectedVersion) {
          fail(`Port ${port} is running VisionPower ${identity.version ?? 'unknown'}, expected ${expectedVersion}`)
          return
        }
        if (expectedConfigPath && identity.configPath !== expectedConfigPath) {
          fail(`Port ${port} is using a different VisionPower config: ${identity.configPath ?? 'unknown'}`)
          return
        }
        resolveProbe(identity)
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('identity probe timed out')))
    req.once('error', (error) => fail(`Could not verify the service listening on port ${port}: ${error.message}`, error))
    req.end()
  })
}

export async function startOrReuseWebuiServer(port, options = {}) {
  try {
    const server = await startWebuiServer(port, options)
    return { server, reused: false, identity: null }
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error
    const identity = await probeWebuiServer(port, options)
    return { server: null, reused: true, identity }
  }
}

async function openBrowser(url) {
  const { execFile } = await import('node:child_process')
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd.exe', ['/d', '/s', '/c', 'start', '', url]]
        : ['xdg-open', [url]]
  execFile(command, args, { windowsHide: true }, () => {})
}
