import { realpathSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { extname, isAbsolute, resolve, sep } from 'node:path'

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

export async function readLocalImageAsBase64(imagePath, config) {
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

export async function describeImage(params, config) {
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
