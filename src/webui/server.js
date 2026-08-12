import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { WEBUI_HTML } from './index-html.js'
import {
  loadVisionConfig,
  DEFAULT_VISION_MODEL,
  DEFAULT_MAX_TOKENS,
  assertSafeApiKey,
  assertSafeModel,
  saveVisionConfig,
  getConfigFilePath,
  getDefaultBaseUrlForModel,
  normalizeBaseUrl,
  normalizeConfigObject,
  resolveModelCapabilities,
  VISION_MODEL_PRESETS,
} from '../config.js'
import { describeImage, normalizeBase64Image, testModelConnection } from '../vision-core.js'
import { deleteStagedImage, listStagedImages, stageImageBuffer } from '../image-inbox.js'

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

const HTML_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: http: https:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

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
        resolveReq(raw ? JSON.parse(raw) : {})
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
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
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

function setHtmlSecurityHeaders(res) {
  setCommonSecurityHeaders(res)
  res.setHeader('Content-Security-Policy', HTML_CSP)
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
    const contentType = meta.contentType?.toLowerCase() ?? ''
    if (!contentType.includes('application/json')) return 'Write request must be JSON'
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

function loadRawConfig() {
  const path = getConfigFilePath()
  if (!existsSync(path)) return {}
  try {
    const fileStat = statSync(path)
    if (!fileStat.isFile() || fileStat.size > SMALL_JSON_BODY_LIMIT) return {}
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
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
    return normalizeBaseUrl(left, 'baseUrl') === normalizeBaseUrl(right, 'baseUrl')
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
  return normalizeBaseUrl(config.baseUrl ?? getDefaultBaseUrlForModel(model), 'baseUrl')
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
    timeoutMs: effective.requestTimeoutMs,
    inboxTtlMs: effective.inbox.ttlMs,
    inboxMaxEntries: effective.inbox.maxEntries,
    // Keep the persisted file key editable without ever returning it in full.
    // If an environment key overrides it, the connection-test path still uses
    // the effective key from loadVisionConfig() when the mask is echoed back.
    apiKey: savedApiKey ? maskApiKey(savedApiKey) : '',
    apiKeyConfigured: Boolean(effective.apiKey),
  }
}

function maxPlaygroundBodyBytes(config) {
  // Base64 expands bytes by roughly 4/3. Leave bounded room for JSON syntax,
  // prompt text, and MIME metadata so the HTTP layer honors maxImageBytes.
  return Math.ceil(config.maxImageBytes / 3) * 4 + JSON_BODY_OVERHEAD
}

async function handleApi(method, url, req, res) {
  // Ignore query strings during route matching so harmless cache-busting or
  // proxy parameters do not turn a valid API endpoint into a 404.
  const pathname = url.split('?')[0]

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

      // Validate + normalize using the same rules loadVisionConfig enforces on
      // read. This drops unknown keys (prototype-pollution guard) and rejects
      // poison values (e.g. cache.ttlMs=0) before they can be persisted — a
      // bad value here would make every subsequent config read throw.
        const cleaned = normalizeConfigObject(configInput)

        // The rendered mask is presentation data, not a protocol sentinel: a
        // legitimate printable API key can equal e.g. `abcd****wxyz`. Preserve
        // only when the client explicitly asks us to, so an edited literal is
        // never silently replaced with the old credential.
        const savedApiKey = rawApiKey(current)
        const currentMasked = savedApiKey ? maskApiKey(savedApiKey) : ''
        if (preserveConfiguredKey) {
          if (cleaned.apiKey && cleaned.apiKey !== currentMasked) {
            throw new Error('preserveConfiguredKey cannot be combined with a new API key')
          }
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

      saveVisionConfig(cleaned)

      const masked = { ...cleaned }
      if (cleaned.apiKey) {
        masked.apiKey = maskApiKey(cleaned.apiKey)
      }
      sendJson(res, 200, { ok: true, config: masked })
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message })
    }
    return true
  }

  // GET /api/presets
  if (method === 'GET' && pathname === '/api/presets') {
    sendJson(res, 200, VISION_MODEL_PRESETS)
    return true
  }

  // GET /api/status
  if (method === 'GET' && pathname === '/api/status') {
    const config = loadVisionConfig()
    sendJson(res, 200, {
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

      const result = await describeImage(params, config)
      sendJson(res, 200, { result })
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message })
    }
    return true
  }

  // POST /api/test-connection
  if (method === 'POST' && pathname === '/api/test-connection') {
    try {
      const body = await readJsonBody(req)
      const unknownKey = Object.keys(body).find((key) => !['apiKey', 'baseUrl', 'model', 'testVision', 'preserveConfiguredKey'].includes(key))
      if (unknownKey) {
        sendJson(res, 400, { error: `Connection test contains an unknown field: ${unknownKey}` })
        return true
      }
      for (const key of ['apiKey', 'baseUrl', 'model']) {
        if (body[key] !== undefined && typeof body[key] !== 'string') {
          sendJson(res, 400, { error: `${key} must be a string` })
          return true
        }
      }
      if (body.testVision !== undefined && typeof body.testVision !== 'boolean') {
        sendJson(res, 400, { error: 'testVision must be a boolean' })
        return true
      }
      if (body.preserveConfiguredKey !== undefined && typeof body.preserveConfiguredKey !== 'boolean') {
        sendJson(res, 400, { error: 'preserveConfiguredKey must be a boolean' })
        return true
      }
      const apiKeyInput = body.apiKey?.trim() ?? ''
      const baseUrlInput = body.baseUrl?.trim() ?? ''
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

      // Normalize before deciding whether a masked/omitted key may be reused.
      // A trailing slash is harmless, but a changed endpoint is a different
      // credential scope and must never receive the key saved for the old one.
      try {
        tempConfig.baseUrl = normalizeBaseUrl(tempConfig.baseUrl, 'baseUrl')
      } catch (err) {
        sendJson(res, 400, { error: err.message })
        return true
      }
      const sameBaseUrl = sameNormalizedBaseUrl(tempConfig.baseUrl, current.baseUrl)

        // The WebUI carries explicit preservation intent. Never infer it from
        // a masked display value: a valid new key can happen to equal that
        // string, and must then be used literally.
        const currentMasked = current.apiKey ? maskApiKey(current.apiKey) : ''
        const savedApiKey = rawApiKey(loadRawConfig())
        const savedMasked = savedApiKey ? maskApiKey(savedApiKey) : ''
        const currentMaskMatch = Boolean(currentMasked && apiKeyInput === currentMasked)
        const savedMaskMatch = Boolean(savedMasked && apiKeyInput === savedMasked)
        if (body.preserveConfiguredKey === true) {
          if (apiKeyInput && !currentMaskMatch && !savedMaskMatch) {
            sendJson(res, 400, { error: 'preserveConfiguredKey cannot be combined with a new API key' })
            return true
          }
          // Always use the effective key from loadVisionConfig(). A file key may
          // coexist with an OPENAI_API_KEY env key; the latter is the credential
          // the running server actually uses when preservation was requested.
          tempConfig.apiKey = sameBaseUrl ? current.apiKey : ''
        } else if (apiKeyInput) {
        tempConfig.apiKey = apiKeyInput
      } else if (body.apiKey !== undefined) {
        tempConfig.apiKey = body.preserveConfiguredKey === true && sameBaseUrl ? current.apiKey : ''
      } else if (!sameBaseUrl) {
        tempConfig.apiKey = ''
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
      if (tempConfig.maxTokens === DEFAULT_MAX_TOKENS && probeCapabilities.recommendedMaxTokens) {
        tempConfig.maxTokens = probeCapabilities.recommendedMaxTokens
      }

      const connectionResult = await testModelConnection(tempConfig, { testVision: body.testVision !== false })
      sendJson(res, 200, { ok: true, message: connectionResult })
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message })
    }
    return true
  }

  // GET /api/export?agent=claude
  if (method === 'GET' && pathname === '/api/export') {
    const u = new URL(url, 'http://localhost')
    const agent = u.searchParams.get('agent') || 'claude'

    // Always export the published npx form — this is what installed users run.
    // The local dev path (src/index.js) is never useful to copy into a host config.
    const serverEntry = {
      command: 'npx',
      args: ['-y', '--package', 'visionpower@latest', 'visionpower'],
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

export function startWebuiServer(port) {
  return new Promise((resolveStart, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const method = req.method || 'GET'
        const url = (req.url || '/').split('?')[0]
        const fullUrl = req.url || '/'

        if (method === 'OPTIONS') {
          setCommonSecurityHeaders(res)
          res.writeHead(204)
          res.end()
          return
        }

        if (url.startsWith('/api/')) {
          const apiError = validateIncomingApiRequest(req, method)
          if (apiError) {
            sendJson(res, 403, { error: apiError })
            return
          }
          const handled = await handleApi(method, fullUrl, req, res)
          if (!handled) sendJson(res, 404, { error: 'Not Found' })
          return
        }

        if (method === 'GET' && url === '/assets/alpine.min.js') {
          sendText(res, 200, loadAlpineScript(), 'text/javascript; charset=utf-8')
          return
        }

        if (url === '/' || url === '/index.html') {
          setHtmlSecurityHeaders(res)
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

    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const actualPort = address && typeof address === 'object' ? address.port : port
      const url = `http://127.0.0.1:${actualPort}`
      process.stderr.write(`\n[visionpower] WebUI started at: ${url}\n`)
      process.stderr.write(`[visionpower] Config file: ${getConfigFilePath()}\n`)
      process.stderr.write(`[visionpower] Press Ctrl+C to stop\n\n`)
      
      if (process.env.VISIONPOWER_NO_OPEN !== '1') {
        openBrowser(url).catch(() => {})
      }
      resolveStart(server)
    })
  })
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
