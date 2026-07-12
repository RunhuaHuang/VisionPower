import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSkillScript } from './build-skill.mjs'
import { getConfigFilePath, getSkillStateFilePath, loadVisionConfig, markSkillConfigNeedsSetup, markSkillConfigVerified, normalizeConfigObject, saveVisionConfig } from '../src/config.js'
import { describeImage } from '../src/vision-core.js'

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const gifBytes = Buffer.from('GIF89a', 'ascii')

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

const tempDir = mkdtempSync(join(tmpdir(), 'visionpower-test-'))
try {
  const pngPath = join(tempDir, 'one.png')
  writeFileSync(pngPath, pngBytes)

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

  // A different image (same prompt) must NOT hit the cache.
  await withMockFetch(async (calls) => {
    await describeImage({ image_base64: gifBytes.toString('base64'), prompt: 'same' }, cacheConfig)
    await describeImage({ image_base64: pngBytes.toString('base64'), prompt: 'same' }, cacheConfig)
    assert.equal(calls.length, 2)
  })

  // --- The generated skill script stays in sync with the core ---
  const generatedSkill = await buildSkillScript()
  const committedSkill = readFileSync(new URL('../VisionPower-Skill/describe_image.mjs', import.meta.url), 'utf8')
  assert.equal(
    generatedSkill,
    committedSkill,
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
  assert.throws(() => cfg({ VISIONPOWER_API_KEY: 'k', VISIONPOWER_MAX_TOKENS: '20abc' }), /positive integer/)
  assert.throws(() => cfg({
    VISIONPOWER_API_KEY: 'k',
    VISIONPOWER_TIMEOUT_MS: 'later',
  }), /VISIONPOWER_TIMEOUT_MS must be a positive integer/)

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

  // allowedDirs accepts an array too.
  assert.deepEqual(normalizeConfigObject({ allowedDirs: ['/x', '/y'] }).allowedDirs, ['/x', '/y'])

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

  console.log('Unit tests passed.')
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
