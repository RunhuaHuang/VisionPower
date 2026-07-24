import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { buildSkillScript } from './build-skill.mjs'
import { getConfigFilePath, getSkillStateFilePath, loadVisionConfig, markSkillConfigNeedsSetup, markSkillConfigVerified, normalizeConfigObject, saveVisionConfig } from '../src/config.js'
import { toolInputSchema } from '../src/schema.js'
import { describeImage } from '../src/vision-core.js'
import { startWebuiServer } from '../src/webui/server.js'

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const gifBytes = Buffer.from('GIF89a', 'ascii')
const littleEndianTiffBytes = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])
const bigEndianTiffBytes = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08])
const littleEndianBigTiffBytes = Buffer.from([
  0x49, 0x49, 0x2b, 0x00, 0x08, 0x00, 0x00, 0x00,
  0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])
const malformedBigTiffBytes = Buffer.from([
  0x49, 0x49, 0x2b, 0x00, 0x04, 0x00, 0x00, 0x00,
  0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])

function testConfig(overrides = {}) {
  return {
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://api.example.com/v1',
    allowedDirs: [],
    maxImageBytes: 20 * 1024 * 1024,
    requestTimeoutMs: 1000,
    maxTokens: 128,
    maxImages: 8,
    maxRetries: 2,
    debug: false,
    // Disable the process-wide result cache by default so each test exercises a
    // real provider call. Cache behavior has its own dedicated tests below.
    cache: { enabled: false, maxEntries: 0, ttlMs: 1000 },
    ...overrides,
  }
}

async function withMockFetch(fn) {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    await fn(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function withSequencedFetch(responses, fn) {
  const originalFetch = globalThis.fetch
  const calls = []
  let index = 0
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    const spec = responses[Math.min(index, responses.length - 1)]
    index += 1
    return new Response(spec.body, {
      status: spec.status,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    await fn(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function assertRejectsMessage(fn, pattern) {
  await assert.rejects(fn, (error) => {
    assert.match(error.message, pattern)
    return true
  })
}

// Synchronous counterpart of assertRejectsMessage: for validators that throw
// immediately (e.g. normalizeConfigObject) rather than returning a rejected promise.
function assertThrowsMessage(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.match(error.message, pattern)
    return true
  })
}

function localHttpRequest(url, { method = 'GET', body, rawBody } = {}) {
  const payload = rawBody ?? (body === undefined ? null : Buffer.from(JSON.stringify(body)))
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest(url, {
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      } : undefined,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = text ? JSON.parse(text) : null } catch { json = null }
        resolveRequest({ status: res.statusCode, text, json })
      })
    })
    req.on('error', rejectRequest)
    if (payload) req.write(payload)
    req.end()
  })
}

const tempDir = mkdtempSync(join(tmpdir(), 'visionpower-test-'))
try {
  const pngPath = join(tempDir, 'one.png')
  writeFileSync(pngPath, pngBytes)
  const tiffPath = join(tempDir, 'one.tiff')
  writeFileSync(tiffPath, littleEndianTiffBytes)
  const tifPath = join(tempDir, 'two.tif')
  writeFileSync(tifPath, bigEndianTiffBytes)

  assert.doesNotThrow(() => toolInputSchema.parse({
    image_base64: littleEndianTiffBytes.toString('base64'),
    image_mime_type: 'image/tiff',
  }))

  // TIFF is validated by its signature and forwarded byte-for-byte. VisionPower
  // does not transcode it or pre-emptively decide whether the configured model
  // supports the format.
  await withMockFetch(async (calls) => {
    const result = await describeImage({
      images: [
        { image_path: tiffPath },
        { image_path: tifPath },
        { image_base64: littleEndianBigTiffBytes.toString('base64'), image_mime_type: 'image/tiff' },
      ],
      prompt: 'Read every image.',
    }, testConfig())

    assert.equal(result, 'ok')
    assert.equal(calls.length, 1)
    const imageParts = calls[0].body.messages[0].content.filter((part) => part.type === 'image_url')
    assert.equal(imageParts.length, 3)
    assert.match(imageParts[0].image_url.url, /^data:image\/tiff;base64,/)
    assert.match(imageParts[1].image_url.url, /^data:image\/tiff;base64,/)
    assert.match(imageParts[2].image_url.url, /^data:image\/tiff;base64,/)
    assert.deepEqual(
      Buffer.from(imageParts[0].image_url.url.split(',')[1], 'base64'),
      littleEndianTiffBytes,
    )
    assert.deepEqual(
      Buffer.from(imageParts[1].image_url.url.split(',')[1], 'base64'),
      bigEndianTiffBytes,
    )
    assert.deepEqual(
      Buffer.from(imageParts[2].image_url.url.split(',')[1], 'base64'),
      littleEndianBigTiffBytes,
    )
  })

  const disguisedTiffPath = join(tempDir, 'disguised.png')
  writeFileSync(disguisedTiffPath, littleEndianTiffBytes)
  await assertRejectsMessage(
    () => describeImage({ image_path: disguisedTiffPath }, testConfig()),
    /extension does not match.*\.png \/ image\/tiff/,
  )
  await assertRejectsMessage(
    () => describeImage({ image_base64: malformedBigTiffBytes.toString('base64') }, testConfig()),
    /not a supported raster image/,
  )

  await withMockFetch(async (calls) => {
    const result = await describeImage({
      images: [
        { image_path: pngPath },
        { image_base64: gifBytes.toString('base64') },
      ],
      prompt: 'Extract visible text.',
    }, testConfig())

    assert.equal(result, 'ok')
    assert.equal(calls.length, 1)
    const content = calls[0].body.messages[0].content
    assert.equal(content[0].text, 'Image 1:')
    assert.match(content[1].image_url.url, /^data:image\/png;base64,/)
    assert.equal(content[2].text, 'Image 2:')
    assert.match(content[3].image_url.url, /^data:image\/gif;base64,/)
    assert.match(content[4].text, /Return your answer in the same order/)
  })

  await assertRejectsMessage(
    () => describeImage({ image_url: 'data:image/png;base64,AAAA' }, testConfig()),
    /http or https/,
  )
  await assertRejectsMessage(
    () => describeImage({ image_url: 'http://localhost/image.png' }, testConfig()),
    /publicly reachable/,
  )
  await assertRejectsMessage(
    () => describeImage({ image_url: 'http://[::ffff:127.0.0.1]/image.png' }, testConfig()),
    /publicly reachable/,
  )
  for (const address of ['100.64.0.1', '192.0.2.1', '198.51.100.2', '203.0.113.3', '224.0.0.1']) {
    await assertRejectsMessage(
      () => describeImage({ image_url: `http://${address}/image.png` }, testConfig()),
      /publicly reachable/,
    )
  }
  await assertRejectsMessage(
    () => describeImage({ image_url: 'https://example.com/image.png' }, testConfig({ apiKey: '' })),
    /Set VISIONPOWER_API_KEY/,
  )
  await assertRejectsMessage(
    () => describeImage({ image_base64: 'not-base64!!!' }, testConfig()),
    /valid standard base64/,
  )
  await assertRejectsMessage(
    () => describeImage({ image_base64: pngBytes.toString('base64'), image_mime_type: 'image/jpeg' }, testConfig()),
    /does not match/,
  )
  await assertRejectsMessage(
    () => describeImage({ image_base64: pngBytes.toString('base64') }, testConfig({ maxImageBytes: 3 })),
    /too large/,
  )
  await assertRejectsMessage(
    () => describeImage({ images: [{ image_path: pngPath, image_url: 'https://example.com/a.png' }] }, testConfig()),
    /exactly one/,
  )
  await assertRejectsMessage(
    () => describeImage({ image_mime_type: 'image/png' }, testConfig()),
    /can only be used/,
  )
  await assertRejectsMessage(
    () => describeImage({ image_path: pngPath, images: [{ image_base64: gifBytes.toString('base64') }] }, testConfig()),
    /either images/,
  )
  await assertRejectsMessage(
    () => describeImage({ image_mime_type: 'image/png', images: [{ image_base64: gifBytes.toString('base64') }] }, testConfig()),
    /either images/,
  )
  await assertRejectsMessage(
    () => describeImage({ images: [{ image_path: pngPath }, { image_base64: gifBytes.toString('base64') }] }, testConfig({ maxImages: 1 })),
    /Too many images/,
  )
  await assertRejectsMessage(
    () => describeImage({ image_path: join(tempDir, 'does-not-exist.png') }, testConfig()),
    /image_path does not exist/,
  )
  await assertRejectsMessage(
    () => describeImage(null, testConfig()),
    /request must be a JSON object/,
  )
  await assertRejectsMessage(
    () => describeImage({ image_base64: 123 }, testConfig()),
    /image_base64 must be a non-empty string/,
  )
  await assertRejectsMessage(
    () => describeImage({ images: 'not-an-array' }, testConfig()),
    /images must be a non-empty array/,
  )
  await assertRejectsMessage(
    () => describeImage({ images: [null] }, testConfig()),
    /images\[0\] must be a JSON object/,
  )
  await assertRejectsMessage(
    () => describeImage({ image_base64: gifBytes.toString('base64'), image_mime_type: 'image/svg+xml' }, testConfig()),
    /supported image MIME type/,
  )
  await assertRejectsMessage(
    () => describeImage({ image_base64: gifBytes.toString('base64'), prompt: 'x'.repeat(20_001) }, testConfig()),
    /prompt must not exceed 20000 characters/,
  )

  // Retries: a retryable status recovers on a later attempt.
  await withSequencedFetch(
    [
      { status: 503, body: 'overloaded' },
      { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }) },
    ],
    async (calls) => {
      const result = await describeImage(
        { image_base64: gifBytes.toString('base64') },
        testConfig({ maxRetries: 1 }),
      )
      assert.equal(result, 'recovered')
      assert.equal(calls.length, 2)
    },
  )

  // Other OpenAI-compatible providers often use a file-type rather than an
  // image-format error label. These should receive the same actionable advice.
  await withSequencedFetch(
    [{ status: 415, body: JSON.stringify({ error: { message: 'unsupported_file_type: image/tiff' } }) }],
    async () => {
      await assertRejectsMessage(
        () => describeImage({ image_path: tiffPath }, testConfig({ model: 'format-test-model' })),
        /configured vision model "format-test-model" rejected image\/tiff input.*PNG\/JPEG/i,
      )
    },
  )

  // "Invalid image format" can also mean malformed image data. Preserve that
  // upstream diagnosis rather than incorrectly claiming a model lacks TIFF support.
  await withSequencedFetch(
    [{ status: 400, body: JSON.stringify({ error: { message: 'invalid image format: corrupt TIFF payload' } }) }],
    async () => {
      await assertRejectsMessage(
        () => describeImage({ image_path: tiffPath }, testConfig({ model: 'format-test-model' })),
        /Vision model API request failed \(400\): .*invalid image format/i,
      )
    },
  )

  // Retries are exhausted after maxRetries and the last status surfaces.
  await withSequencedFetch(
    [{ status: 503, body: 'still-overloaded' }],
    async (calls) => {
      await assertRejectsMessage(
        () => describeImage({ image_base64: gifBytes.toString('base64') }, testConfig({ maxRetries: 1 })),
        /failed \(503\)/,
      )
      assert.equal(calls.length, 2)
    },
  )

  // Non-retryable client errors fail immediately without retrying.
  await withSequencedFetch(
    [{ status: 400, body: 'bad request' }],
    async (calls) => {
      await assertRejectsMessage(
        () => describeImage({ image_base64: gifBytes.toString('base64') }, testConfig({ maxRetries: 2 })),
        /failed \(400\)/,
      )
      assert.equal(calls.length, 1)
    },
  )

  // Providers decide format support. When one explicitly rejects TIFF,
  // VisionPower explains that it forwarded the original bytes and suggests
  // changing model or converting externally instead of silently transcoding.
  await withSequencedFetch(
    [{
      status: 400,
      body: JSON.stringify({
        type: 'error',
        error: {
          type: 'bad_request_error',
          message: 'invalid param: image format ".tiff" not allowed (2013)',
        },
      }),
    }],
    async (calls) => {
      await assertRejectsMessage(
        () => describeImage(
          { image_path: tiffPath },
          testConfig({ model: 'MiniMax-M3', maxRetries: 2 }),
        ),
        /configured vision model "MiniMax-M3" rejected image\/tiff input.*forwarded the original image without conversion.*PNG\/JPEG.*image format "\.tiff" not allowed/i,
      )
      assert.equal(calls.length, 1)
    },
  )

  // --- In-memory result cache: identical input is served without a second call ---
  const cacheConfig = testConfig({
    cache: { enabled: true, maxEntries: 8, ttlMs: 5_000 },
    // Distinct model so this never collides with another test's cache key.
    model: 'cache-test-model',
  })
  await withMockFetch(async (calls) => {
    const base64 = gifBytes.toString('base64')
    const first = await describeImage({ image_base64: base64, prompt: 'describe' }, cacheConfig)
    const second = await describeImage({ image_base64: base64, prompt: 'describe' }, cacheConfig)
    assert.equal(first, 'ok')
    assert.equal(second, 'ok')
    // Same image+prompt+model+maxTokens → exactly one provider call, the second is cached.
    assert.equal(calls.length, 1)
  })

  // A different prompt (or model) must NOT hit the cache — it bills a new call.
  await withMockFetch(async (calls) => {
    const base64 = gifBytes.toString('base64')
    await describeImage({ image_base64: base64, prompt: 'one' }, cacheConfig)
    await describeImage({ image_base64: base64, prompt: 'two' }, cacheConfig)
    assert.equal(calls.length, 2)
  })

  // Cache entries must never cross provider endpoints or credentials, even
  // when those providers expose the same model ID.
  await withMockFetch(async (calls) => {
    const input = { image_base64: gifBytes.toString('base64'), prompt: 'cache provider scope' }
    await describeImage(input, testConfig({ ...cacheConfig, baseUrl: 'https://one.example/v1', apiKey: 'key-one' }))
    await describeImage(input, testConfig({ ...cacheConfig, baseUrl: 'https://two.example/v1', apiKey: 'key-one' }))
    await describeImage(input, testConfig({ ...cacheConfig, baseUrl: 'https://two.example/v1', apiKey: 'key-two' }))
    assert.equal(calls.length, 3)
  })

  // Public URLs are mutable references, so repeating one must call the model
  // again instead of returning a potentially stale cached answer.
  await withMockFetch(async (calls) => {
    const input = { image_url: 'https://images.example/current.png', prompt: 'mutable URL' }
    await describeImage(input, cacheConfig)
    await describeImage(input, cacheConfig)
    assert.equal(calls.length, 2)
  })

  // A different image (same prompt) must NOT hit the cache.
  await withMockFetch(async (calls) => {
    await describeImage({ image_base64: gifBytes.toString('base64'), prompt: 'same' }, cacheConfig)
    await describeImage({ image_base64: pngBytes.toString('base64'), prompt: 'same' }, cacheConfig)
    assert.equal(calls.length, 2)
  })

  // --- The generated skill script stays in sync with the core ---
  const generatedSkill = await buildSkillScript()
  const committedSkill = readFileSync(new URL('../VisionPower-Skill/describe_image.mjs', import.meta.url), 'utf8')
  assert.ok(!generatedSkill.includes('\r'), 'generated Skill must use LF line endings on every platform')
  assert.equal(
    generatedSkill,
    committedSkill.replace(/\r\n?/g, '\n'),
    'VisionPower-Skill/describe_image.mjs is out of date; run `npm run build:skill`',
  )

  // Keep the MCP server's advertised version in lockstep with package.json.
  // The version must not be hardcoded — src/index.js must read it from package.json.
  const serverSource = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.ok(
    serverSource.includes(`require('../package.json')`) && serverSource.includes('version,'),
    'src/index.js must read version from package.json (not hardcode it)',
  )

  // Env-only resolution must not be affected by a real config file on the test
  // machine, so point VISIONPOWER_CONFIG at a path that does not exist.
  const absentConfig = join(tempDir, 'absent-config.json')
  const cfg = (overrides = {}) => loadVisionConfig({ VISIONPOWER_CONFIG: absentConfig, ...overrides })

  const normalized = cfg({
    VISIONPOWER_API_KEY: 'k',
    VISIONPOWER_BASE_URL: 'https://api.example.com/v1//',
  })
  assert.equal(normalized.baseUrl, 'https://api.example.com/v1')
  assert.equal(normalized.maxImageBytes, 20 * 1024 * 1024)

  const visionpowerEnv = cfg({
    VISIONPOWER_API_KEY: 'visionpower-key',
    VISIONPOWER_MODEL: 'visionpower-model',
    VISIONPOWER_BASE_URL: 'https://visionpower.example.com/v1/',
    VISIONPOWER_ALLOWED_DIRS: '/tmp, /var/tmp',
    VISIONPOWER_MAX_IMAGE_BYTES: '12345',
    VISIONPOWER_TIMEOUT_MS: '23456',
    VISIONPOWER_MAX_TOKENS: '3456',
    VISIONPOWER_MAX_IMAGES: '4',
  })
  assert.equal(visionpowerEnv.apiKey, 'visionpower-key')
  assert.equal(visionpowerEnv.model, 'visionpower-model')
  assert.equal(visionpowerEnv.baseUrl, 'https://visionpower.example.com/v1')
  assert.deepEqual(visionpowerEnv.allowedDirs, ['/tmp', '/var/tmp'])
  assert.equal(visionpowerEnv.maxImageBytes, 12345)
  assert.equal(visionpowerEnv.requestTimeoutMs, 23456)
  assert.equal(visionpowerEnv.maxTokens, 3456)
  assert.equal(visionpowerEnv.maxImages, 4)

  const precedence = cfg({
    VISIONPOWER_API_KEY: 'visionpower-key',
    OPENAI_API_KEY: 'openai-key',
    VISIONPOWER_MODEL: 'visionpower-model',
    VISIONPOWER_BASE_URL: 'https://visionpower.example.com/v1',
  })
  assert.equal(precedence.apiKey, 'visionpower-key')
  assert.equal(precedence.model, 'visionpower-model')
  assert.equal(precedence.baseUrl, 'https://visionpower.example.com/v1')

  const openaiFallback = cfg({ OPENAI_API_KEY: 'openai-key' })
  assert.equal(openaiFallback.apiKey, 'openai-key')

  const retryDefaults = cfg({ VISIONPOWER_API_KEY: 'k' })
  assert.equal(retryDefaults.maxRetries, 2)
  assert.equal(retryDefaults.debug, false)

  const retryOverrides = cfg({
    VISIONPOWER_API_KEY: 'k',
    VISIONPOWER_MAX_RETRIES: '0',
    VISIONPOWER_DEBUG: 'true',
  })
  assert.equal(retryOverrides.maxRetries, 0)
  assert.equal(retryOverrides.debug, true)

  assert.throws(() => cfg({ VISIONPOWER_API_KEY: 'k', VISIONPOWER_MAX_RETRIES: '-1' }), /non-negative integer/)
  assert.throws(() => cfg({ VISIONPOWER_API_KEY: 'k', VISIONPOWER_DEBUG: 'maybe' }), /must be a boolean/)
  assert.throws(() => cfg({
    VISIONPOWER_API_KEY: 'k',
    VISIONPOWER_BASE_URL: 'https://api.example.com/v1/chat/completions',
  }), /should not include/)
  assert.throws(() => cfg({
    VISIONPOWER_API_KEY: 'k',
    VISIONPOWER_BASE_URL: 'file:///tmp/model',
  }), /VISIONPOWER_BASE_URL must use http or https/)
  assert.throws(() => cfg({
    VISIONPOWER_API_KEY: 'k',
    VISIONPOWER_BASE_URL: 'https://user:password@api.example.com/v1',
  }), /VISIONPOWER_BASE_URL must not include credentials/)
  assert.throws(() => cfg({ VISIONPOWER_API_KEY: 'k', VISIONPOWER_MAX_TOKENS: '20abc' }), /positive integer/)
  assert.throws(() => cfg({
    VISIONPOWER_API_KEY: 'k',
    VISIONPOWER_TIMEOUT_MS: 'later',
  }), /VISIONPOWER_TIMEOUT_MS must be a positive integer/)
  assert.throws(() => cfg({
    VISIONPOWER_API_KEY: 'k',
    VISIONPOWER_TIMEOUT_MS: '2147483648',
  }), /VISIONPOWER_TIMEOUT_MS must not exceed 2147483647/)

  // --- Persistent config file (env still wins over it) ---
  const fileConfigPath = join(tempDir, 'vp-config.json')
  writeFileSync(fileConfigPath, JSON.stringify({
    apiKey: 'file-key',
    model: 'file-model',
    baseUrl: 'https://file.example.com/v1',
    maxImages: 3,
  }))
  const fromFile = loadVisionConfig({ VISIONPOWER_CONFIG: fileConfigPath })
  assert.equal(fromFile.apiKey, 'file-key')
  assert.equal(fromFile.model, 'file-model')
  assert.equal(fromFile.baseUrl, 'https://file.example.com/v1')
  assert.equal(fromFile.maxImages, 3)
  assert.deepEqual(fromFile.cache, { enabled: true, maxEntries: 32, ttlMs: 30 * 60 * 1000 }) // cache defaults to on

  // Cache config file keys + env overrides.
  const cacheFileConfigPath = join(tempDir, 'vp-cache.json')
  writeFileSync(cacheFileConfigPath, JSON.stringify({
    apiKey: 'file-key',
    cache: { maxEntries: 5, ttlMs: 12_000 },
  }))
  const cacheFile = loadVisionConfig({ VISIONPOWER_CONFIG: cacheFileConfigPath })
  assert.deepEqual(cacheFile.cache, { enabled: true, maxEntries: 5, ttlMs: 12_000 })

  const cacheDisabled = loadVisionConfig({ VISIONPOWER_CONFIG: absentConfig, VISIONPOWER_API_KEY: 'k', VISIONPOWER_CACHE: 'false' })
  assert.equal(cacheDisabled.cache.enabled, false)
  const cacheEntries = cfg({ VISIONPOWER_API_KEY: 'k', VISIONPOWER_CACHE_MAX_ENTRIES: '7', VISIONPOWER_CACHE_TTL_MS: '9000' })
  assert.deepEqual(cacheEntries.cache, { enabled: true, maxEntries: 7, ttlMs: 9000 })
  // maxEntries of zero disables the cache (store nothing).
  assert.equal(cfg({ VISIONPOWER_API_KEY: 'k', VISIONPOWER_CACHE_MAX_ENTRIES: '0' }).cache.enabled, false)

  const envBeatsFile = loadVisionConfig({ VISIONPOWER_CONFIG: fileConfigPath, VISIONPOWER_API_KEY: 'env-key' })
  assert.equal(envBeatsFile.apiKey, 'env-key')   // env wins
  assert.equal(envBeatsFile.model, 'file-model') // file used where env is absent

  const envStyleFileConfigPath = join(tempDir, 'vp-env-style-config.json')
  writeFileSync(envStyleFileConfigPath, JSON.stringify({
    VISIONPOWER_API_KEY: 'env-style-file-key',
    VISIONPOWER_MODEL: 'env-style-file-model',
    VISIONPOWER_BASE_URL: 'https://env-style-file.example.com/v1',
  }))
  const fromEnvStyleFile = loadVisionConfig({ VISIONPOWER_CONFIG: envStyleFileConfigPath })
  assert.equal(fromEnvStyleFile.apiKey, 'env-style-file-key')
  assert.equal(fromEnvStyleFile.model, 'env-style-file-model')
  assert.equal(fromEnvStyleFile.baseUrl, 'https://env-style-file.example.com/v1')

  const missingFile = loadVisionConfig({ VISIONPOWER_CONFIG: join(tempDir, 'nope.json') })
  assert.equal(missingFile.apiKey, '')           // an absent config file is fine

  const badFileConfigPath = join(tempDir, 'vp-bad.json')
  writeFileSync(badFileConfigPath, JSON.stringify({ maxRetries: -1 }))
  assert.throws(
    () => loadVisionConfig({ VISIONPOWER_CONFIG: badFileConfigPath }),
    /config file "maxRetries" must be a non-negative integer/,
  )
  writeFileSync(badFileConfigPath, JSON.stringify({ cache: 'enabled' }))
  assert.throws(
    () => loadVisionConfig({ VISIONPOWER_CONFIG: badFileConfigPath }),
    /config file "cache" must be an object/,
  )
  writeFileSync(badFileConfigPath, JSON.stringify({ allowedDirs: ['/tmp', 123] }))
  assert.throws(
    () => loadVisionConfig({ VISIONPOWER_CONFIG: badFileConfigPath }),
    /config file "allowedDirs" entries must be strings/,
  )

  // --- Skill setup state marker ---
  const skillStatePath = join(tempDir, 'skill-state.json')
  await markSkillConfigVerified(
    testConfig({ model: 'state-model', baseUrl: 'https://state.example.com/v1' }),
    { VISIONPOWER_SKILL_STATE: skillStatePath },
  )
  const verifiedState = JSON.parse(readFileSync(skillStatePath, 'utf8'))
  assert.equal(verifiedState.version, 1)
  assert.equal(verifiedState.configVerified, true)
  assert.equal(verifiedState.model, 'state-model')
  assert.equal(verifiedState.baseUrl, 'https://state.example.com/v1')
  assert.match(verifiedState.verifiedAt, /^\d{4}-\d{2}-\d{2}T/)
  if (process.platform !== 'win32') {
    assert.equal(statSync(skillStatePath).mode & 0o777, 0o600)
  }

  await markSkillConfigNeedsSetup('Bearer secret-token and apiKey: sk-testSECRET123456 are not configured', { VISIONPOWER_SKILL_STATE: skillStatePath })
  const failedState = JSON.parse(readFileSync(skillStatePath, 'utf8'))
  assert.equal(failedState.configVerified, false)
  assert.match(failedState.needsSetupAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(failedState.reason, 'Bearer [REDACTED] and apiKey: [REDACTED_API_KEY] are not configured')

  // Writing state again cleans up orphaned temp files (older than 1h) from a
  // prior crashed write, but leaves recent ones and unrelated files alone.
  {
    const cleanupDir = mkdtempSync(join(tmpdir(), 'visionpower-cleanup-'))
    const cleanupStatePath = join(cleanupDir, 'skill-state.json')
    const staleTemp = `${cleanupStatePath}.1111.1000.tmp`     // old orphan temp
    const freshTemp = `${cleanupStatePath}.2222.2000.tmp`     // recent orphan temp
    const unrelated = join(cleanupDir, 'unrelated.tmp')       // not our pattern
    writeFileSync(staleTemp, 'orphan')
    writeFileSync(freshTemp, 'orphan')
    writeFileSync(unrelated, 'keep')
    const twoHoursAgo = (Date.now() / 1000) - 2 * 60 * 60
    const tenMinutesAgo = (Date.now() / 1000) - 10 * 60
    utimesSync(staleTemp, twoHoursAgo, twoHoursAgo)
    utimesSync(freshTemp, tenMinutesAgo, tenMinutesAgo)
    utimesSync(unrelated, twoHoursAgo, twoHoursAgo)

    await markSkillConfigVerified(testConfig(), { VISIONPOWER_SKILL_STATE: cleanupStatePath })

    assert.equal(existsSync(staleTemp), false, 'stale orphan temp should be removed')
    assert.equal(existsSync(freshTemp), true, 'recent orphan temp should be kept')
    assert.equal(existsSync(unrelated), true, 'unrelated files must not be touched')
    rmSync(cleanupDir, { recursive: true, force: true })
  }

  if (process.platform !== 'win32') {
    const symlinkTarget = join(tempDir, 'symlink-target.json')
    const symlinkStatePath = join(tempDir, 'symlink-state.json')
    writeFileSync(symlinkTarget, 'do-not-overwrite')
    symlinkSync(symlinkTarget, symlinkStatePath)
    await markSkillConfigVerified(testConfig(), { VISIONPOWER_SKILL_STATE: symlinkStatePath })
    assert.equal(readFileSync(symlinkTarget, 'utf8'), 'do-not-overwrite')
    const replacedState = JSON.parse(readFileSync(symlinkStatePath, 'utf8'))
    assert.equal(replacedState.configVerified, true)
  }

  // --- 默认路径分支必须真正执行到 ---
  // 回归保护：曾经因为所有测试都注入 VISIONPOWER_CONFIG，导致 `|| join(homedir(), ...)`
  // 右侧分支从未被触发，homedir 未导入的 bug 测不出来。这里显式不传环境变量，
  // 强制走 homedir() 默认路径——若 homedir 的 import 被删除，下面会立即抛错。
  const defaultConfigPath = getConfigFilePath({})
  assert.match(
    defaultConfigPath,
    /[\\/]\.visionpower[\\/]config\.json$/,
    '默认配置路径应落在 ~/.visionpower/config.json',
  )
  const defaultStatePath = getSkillStateFilePath({})
  assert.match(
    defaultStatePath,
    /[\\/]\.visionpower[\\/]skill-state\.json$/,
    '默认 skill-state 路径应落在 ~/.visionpower/skill-state.json',
  )
  // 环境变量仍应优先于默认路径
  assert.equal(getConfigFilePath({ VISIONPOWER_CONFIG: '/x/y.json' }), '/x/y.json')
  assert.equal(getSkillStateFilePath({ VISIONPOWER_SKILL_STATE: '/s/t.json' }), '/s/t.json')

  // --- normalizeConfigObject: WebUI config validation ---
  // (Regression for the v2.0.0 bug where PUT /api/config wrote values that
  // made every subsequent loadVisionConfig() throw — e.g. cache.ttlMs=0,
  // maxRetries=-1, or an un-normalized baseUrl.)

  // Unknown keys are dropped (prototype-pollution guard), known fields validated.
  const clean = normalizeConfigObject({
    apiKey: 'sk-test',
    model: 'qwen3-vl-flash',
    baseUrl: 'https://api.example.com/v1/',
    maxImageBytes: 1024,
    timeoutMs: 1000,
    maxTokens: 128,
    maxImages: 4,
    maxRetries: 1,
    debug: true,
    cache: { enabled: true, maxEntries: 10, ttlMs: 5000 },
    allowedDirs: '/a, /b',
    __proto__: { x: 1 },          // must be dropped
    constructor: 'evil',           // must be dropped
  })
  assert.equal(clean.apiKey, 'sk-test')
  assert.equal(clean.baseUrl, 'https://api.example.com/v1') // trailing slash stripped
  assert.deepEqual(clean.allowedDirs, ['/a', '/b'])
  assert.equal(clean.maxRetries, 1)
  assert.deepEqual(clean.cache, { enabled: true, maxEntries: 10, ttlMs: 5000 })
  assert.equal(clean.__proto__?.x, undefined)
  assert.equal(clean.constructor, Object.prototype.constructor) // not the string

  // baseUrl with /chat/completions suffix is rejected (mirrors loadVisionConfig).
  assertThrowsMessage(
    () => normalizeConfigObject({ baseUrl: 'https://api.example.com/v1/chat/completions' }),
    /should not include/,
  )

  // baseUrl with a non-http scheme is rejected.
  assertThrowsMessage(
    () => normalizeConfigObject({ baseUrl: 'file:///tmp' }),
    /baseUrl must use http or https/,
  )
  assertThrowsMessage(
    () => normalizeConfigObject({ baseUrl: 'https://user:password@api.example.com/v1' }),
    /baseUrl must not include credentials/,
  )

  // The three "poison value" regressions that broke loadVisionConfig on read:
  assertThrowsMessage(
    () => normalizeConfigObject({ cache: { ttlMs: 0 } }),
    /cache.ttlMs.*positive integer/,
  )
  assertThrowsMessage(
    () => normalizeConfigObject({ maxRetries: -1 }),
    /maxRetries.*non-negative integer/,
  )
  assertThrowsMessage(
    () => normalizeConfigObject({ maxImages: 0 }),
    /maxImages.*positive integer/,
  )
  assertThrowsMessage(
    () => normalizeConfigObject({ timeoutMs: 2_147_483_648 }),
    /timeoutMs.*must not exceed 2147483647/,
  )

  // allowedDirs accepts an array too.
  assert.deepEqual(normalizeConfigObject({ allowedDirs: ['/x', '/y'] }).allowedDirs, ['/x', '/y'])
  assertThrowsMessage(
    () => normalizeConfigObject({ allowedDirs: ['/x', 123] }),
    /allowedDirs entries must be strings/,
  )

  // apiKey/model: non-string and null values must be rejected/dropped, not
  // persisted — otherwise loadVisionConfig's stringFromFile throws on read.
  assertThrowsMessage(
    () => normalizeConfigObject({ apiKey: 123 }),
    /apiKey.*string/,
  )
  assertThrowsMessage(
    () => normalizeConfigObject({ model: 456 }),
    /model.*string/,
  )
  assertThrowsMessage(
    () => normalizeConfigObject({ model: '   ' }),
    /model.*empty/,
  )
  // null is dropped (not persisted), so a subsequent load is unaffected.
  assert.equal(normalizeConfigObject({ apiKey: null }).apiKey, undefined)
  assert.equal(normalizeConfigObject({ model: null }).model, undefined)
  // empty apiKey is allowed (user is clearing the key); it trims to ''.
  assert.equal(normalizeConfigObject({ apiKey: '  ' }).apiKey, '')

  // Full round-trip: a validated object survives save -> load.
  {
    const rt = join(tempDir, 'rt-config.json')
    const validated = normalizeConfigObject({
      apiKey: 'rt-key',
      model: 'qwen3-vl-plus',
      baseUrl: 'https://api.example.com/v1',
      maxImages: 5,
      cache: { enabled: false, maxEntries: 0, ttlMs: 60_000 },
    })
    saveVisionConfig(validated, { VISIONPOWER_CONFIG: rt })
    const loaded = loadVisionConfig({ VISIONPOWER_CONFIG: rt })
    assert.equal(loaded.apiKey, 'rt-key')
    assert.equal(loaded.model, 'qwen3-vl-plus')
    assert.equal(loaded.maxImages, 5)
    // maxEntries:0 disables the cache on read (matches the documented behavior).
    assert.equal(loaded.cache.enabled, false)
    assert.equal(loaded.cache.maxEntries, 0)
  }

  // --- WebUI integration: effective env config and status stay aligned with
  // the same precedence rules used by MCP calls. In particular,
  // OPENAI_API_KEY alone must make the console ready without exposing it.
  {
    const envNames = [
      'VISIONPOWER_CONFIG', 'VISIONPOWER_API_KEY', 'OPENAI_API_KEY',
      'VISIONPOWER_MODEL', 'VISIONPOWER_BASE_URL', 'VISIONPOWER_NO_OPEN',
    ]
    const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]))
    let webuiServer
    try {
      process.env.VISIONPOWER_CONFIG = join(tempDir, 'webui-absent.json')
      process.env.VISIONPOWER_API_KEY = ''
      process.env.OPENAI_API_KEY = 'openai-env-secret'
      process.env.VISIONPOWER_MODEL = 'gpt-4o'
      delete process.env.VISIONPOWER_BASE_URL
      process.env.VISIONPOWER_NO_OPEN = '1'

      webuiServer = await startWebuiServer(0)
      const address = webuiServer.address()
      assert.ok(address && typeof address === 'object')
      const origin = `http://127.0.0.1:${address.port}`

      const configResponse = await fetch(`${origin}/api/config`)
      assert.equal(configResponse.status, 200)
      const webuiConfig = await configResponse.json()
      assert.equal(webuiConfig.model, 'gpt-4o')
      assert.equal(webuiConfig.baseUrl, 'https://api.openai.com/v1')
      assert.equal(webuiConfig.apiKey, '')
      assert.equal(webuiConfig.apiKeyConfigured, true)
      assert.equal(webuiConfig.timeoutMs, 60_000)
      assert.equal(webuiConfig.requestTimeoutMs, undefined)

      const statusResponse = await fetch(`${origin}/api/status`)
      assert.equal(statusResponse.status, 200)
      assert.equal((await statusResponse.json()).ready, true)

      // A masked key originating in the config file must never become the
      // temporary connection-test credential when an env key overrides it.
      const savedKey = 'file-secret-1234567890'
      writeFileSync(process.env.VISIONPOWER_CONFIG, JSON.stringify({ apiKey: savedKey }))
      const mixedConfigResponse = await fetch(`${origin}/api/config`)
      const mixedConfig = await mixedConfigResponse.json()
      assert.equal(mixedConfig.apiKey, 'file****7890')

      const originalFetch = globalThis.fetch
      const providerCalls = []
      try {
        globalThis.fetch = async (url, options) => {
          providerCalls.push({ url, options })
          return new Response(JSON.stringify({ choices: [{ message: { content: 'connected' } }] }), { status: 200 })
        }
        const connectionResponse = await localHttpRequest(`${origin}/api/test-connection`, {
          method: 'POST',
          body: {
            apiKey: mixedConfig.apiKey,
            model: mixedConfig.model,
            baseUrl: mixedConfig.baseUrl,
          },
        })
        assert.equal(connectionResponse.status, 200)
        assert.equal(connectionResponse.json.message, 'connected')
        assert.equal(providerCalls.length, 1)
        assert.equal(providerCalls[0].options.headers.Authorization, 'Bearer openai-env-secret')
      } finally {
        globalThis.fetch = originalFetch
      }

      // Oversized small JSON endpoints report the correct HTTP status without
      // destroying the server connection.
      const oversizedResponse = await localHttpRequest(`${origin}/api/config`, {
        method: 'PUT',
        rawBody: Buffer.alloc(1024 * 1024 + 1, 0x61),
      })
      assert.equal(oversizedResponse.status, 413)
      assert.match(oversizedResponse.json.error, /Request body too large/)

      const webuiSource = readFileSync(new URL('../src/webui/index-html.js', import.meta.url), 'utf8')
      assert.ok(webuiSource.includes("removeLocalPreference('vp-keys-by-url')"))
      assert.ok(!webuiSource.includes("localStorage.setItem('vp-keys-by-url'"))
      assert.ok(webuiSource.includes('image/tiff,.tif,.tiff'))
      assert.ok(webuiSource.includes('JPG, PNG, WEBP, GIF, BMP, TIFF'))
      assert.ok(webuiSource.includes('previewUnavailable'))
      assert.ok(webuiSource.includes('(!playground.imageBytes && !playground.imageUrl)'))
    } finally {
      if (webuiServer) {
        await new Promise((resolveClose, rejectClose) => {
          webuiServer.close((error) => error ? rejectClose(error) : resolveClose())
        })
      }
      for (const [name, value] of originalEnv) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }

  console.log('Unit tests passed.')
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
