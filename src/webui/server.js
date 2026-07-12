import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { WEBUI_HTML } from './index-html.js'
import {
  loadVisionConfig,
  saveVisionConfig,
  getConfigFilePath,
  normalizeBaseUrl,
  normalizeConfigObject,
  VISION_MODEL_PRESETS,
} from '../config.js'
import { describeImage, testModelConnection } from '../vision-core.js'

const require = createRequire(import.meta.url)
let alpineScriptCache = null

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
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

function readJsonBody(req) {
  return new Promise((resolveReq, reject) => {
    const chunks = []
    req.on('data', (c) => {
      chunks.push(c)
      if (chunks.reduce((a, c) => a + c.length, 0) > 10 * 1024 * 1024) {
        reject(new Error('Request body too large (>10MB)'))
        req.destroy()
      }
    })
    req.on('end', () => {
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
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function handleApi(method, url, req, res) {
  // GET /api/config
  if (method === 'GET' && url === '/api/config') {
    const config = loadRawConfig()
    const masked = { ...config }
    if (config.apiKey) {
      masked.apiKey = maskApiKey(config.apiKey)
    }
    sendJson(res, 200, masked)
    return true
  }

  // PUT /api/config
  if (method === 'PUT' && url === '/api/config') {
    try {
      const body = await readJsonBody(req)
      const current = loadRawConfig()

      // Validate + normalize using the same rules loadVisionConfig enforces on
      // read. This drops unknown keys (prototype-pollution guard) and rejects
      // poison values (e.g. cache.ttlMs=0) before they can be persisted — a
      // bad value here would make every subsequent config read throw.
      const cleaned = normalizeConfigObject(body)

      // Preserve the real key when the frontend sends back the masked form. We
      // compare against maskApiKey()'s exact output rather than a substring
      // test, so a real key that happens to contain '*' is never misread.
      const currentMasked = current.apiKey ? maskApiKey(current.apiKey) : ''
      if (typeof cleaned.apiKey === 'string' && currentMasked && cleaned.apiKey === currentMasked) {
        cleaned.apiKey = current.apiKey
      }

      saveVisionConfig(cleaned)

      const masked = { ...cleaned }
      if (cleaned.apiKey) {
        masked.apiKey = maskApiKey(cleaned.apiKey)
      }
      sendJson(res, 200, { ok: true, config: masked })
    } catch (err) {
      sendJson(res, 400, { error: err.message })
    }
    return true
  }

  // GET /api/presets
  if (method === 'GET' && url === '/api/presets') {
    sendJson(res, 200, VISION_MODEL_PRESETS)
    return true
  }

  // GET /api/status
  if (method === 'GET' && url === '/api/status') {
    const raw = loadRawConfig()
    const ready = !!(raw.apiKey || process.env.VISIONPOWER_API_KEY)
    sendJson(res, 200, {
      ready,
      configPath: getConfigFilePath(),
    })
    return true
  }

  // POST /api/test
  if (method === 'POST' && url === '/api/test') {
    try {
      const body = await readJsonBody(req)
      const config = loadVisionConfig()
      
      // Playground only accepts URL and base64 inputs — image_path is explicitly
      // blocked here because the playground runs in a browser context and must
      // not be used to read arbitrary local files on the server.
      const params = {
        prompt: typeof body.prompt === 'string' ? body.prompt : 'Describe this image.',
      }
      if (typeof body.image_url === 'string' && body.image_url) {
        params.image_url = body.image_url
      } else if (typeof body.image_base64 === 'string' && body.image_base64) {
        params.image_base64 = body.image_base64
        if (typeof body.image_mime_type === 'string') {
          params.image_mime_type = body.image_mime_type
        }
      } else {
        sendJson(res, 400, { error: 'Provide image_url or image_base64' })
        return true
      }

      const result = await describeImage(params, config)
      sendJson(res, 200, { result })
    } catch (err) {
      sendJson(res, 400, { error: err.message })
    }
    return true
  }

  // POST /api/test-connection
  if (method === 'POST' && url === '/api/test-connection') {
    try {
      const body = await readJsonBody(req)
      const current = loadVisionConfig()
      
      const tempConfig = {
        ...current,
        requestTimeoutMs: current.requestTimeoutMs || 60000,
      }

      // Keep the saved key when the frontend sends back the masked form. Use
      // an exact comparison against maskApiKey()'s output (matching PUT
      // /api/config) rather than a substring test, so a real key that happens
      // to contain '*' is never mistaken for the mask.
      const currentMasked = current.apiKey ? maskApiKey(current.apiKey) : ''
      if (typeof body.apiKey === 'string' && body.apiKey) {
        if (!(currentMasked && body.apiKey === currentMasked)) {
          tempConfig.apiKey = body.apiKey
        }
      }
      if (typeof body.baseUrl === 'string' && body.baseUrl) {
        tempConfig.baseUrl = body.baseUrl
      }
      if (typeof body.model === 'string' && body.model) {
        tempConfig.model = body.model
      }

      if (!tempConfig.apiKey) {
        sendJson(res, 400, { error: 'API key is required for testing' })
        return true
      }

      // Normalize baseUrl the same way loadVisionConfig does, so the connection
      // test sees the same URL the saved config would actually use. Without
      // this, a trailing slash or a /chat/completions suffix would make the
      // test fail even though the real server would work fine.
      try {
        tempConfig.baseUrl = normalizeBaseUrl(tempConfig.baseUrl, 'baseUrl')
      } catch (err) {
        sendJson(res, 400, { error: err.message })
        return true
      }

      const connectionResult = await testModelConnection(tempConfig)
      sendJson(res, 200, { ok: true, message: connectionResult })
    } catch (err) {
      sendJson(res, 400, { error: err.message })
    }
    return true
  }

  // GET /api/export?agent=claude
  if (method === 'GET' && url.startsWith('/api/export')) {
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
        if (!res.headersSent) {
          sendJson(res, 500, { error: err.message })
        }
      }
    })

    server.on('error', reject)

    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}`
      process.stderr.write(`\n[visionpower] WebUI started at: ${url}\n`)
      process.stderr.write(`[visionpower] Config file: ${getConfigFilePath()}\n`)
      process.stderr.write(`[visionpower] Press Ctrl+C to stop\n\n`)
      
      if (process.env.VISIONPOWER_NO_OPEN !== '1') {
        openBrowser(url).catch(() => {})
      }
      resolveStart()
    })
  })
}

async function openBrowser(url) {
  const { exec } = await import('node:child_process')
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`
  exec(cmd, () => {})
}
