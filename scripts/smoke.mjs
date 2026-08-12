import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { stageImageBuffer } from '../src/image-inbox.js'

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/index.js'],
  env: {
    ...process.env,
    VISIONPOWER_API_KEY: '',
    OPENAI_API_KEY: '',
    VISIONPOWER_CONFIG: '/nonexistent/visionpower-smoke-config.json',
  },
})

const client = new Client({
  name: 'visionpower-smoke-test',
  version: '2.0.3',
})

try {
  await client.connect(transport)
  const tools = await client.listTools()
  const names = tools.tools.map((tool) => tool.name)
  if (!names.includes('describe_image')) {
    throw new Error(`describe_image tool missing; got ${names.join(', ')}`)
  }
  const describeTool = tools.tools.find((tool) => tool.name === 'describe_image')
  if (describeTool?.annotations?.openWorldHint !== true
    || describeTool?.annotations?.readOnlyHint === true
    || describeTool?.annotations?.destructiveHint === false
    || describeTool?.annotations?.idempotentHint === true) {
    throw new Error(`describe_image annotations make an unsafe behavior claim: ${JSON.stringify(describeTool?.annotations)}`)
  }

  const result = await client.callTool({
    name: 'describe_image',
    arguments: {},
  })
  if (!result.isError) {
    throw new Error('Expected missing-input call to return isError=true')
  }

  console.log('Smoke test passed: describe_image is listed and callable.')
} finally {
  await client.close()
}

// Skill script: self-contained, and an empty request exits non-zero with a helpful error.
const skillExit = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['VisionPower-Skill/describe_image.mjs'], {
    env: {
      ...process.env,
      VISIONPOWER_API_KEY: '',
      OPENAI_API_KEY: '',
      VISIONPOWER_CONFIG: '/nonexistent/visionpower-smoke-config.json',
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code, stderr }))
  child.stdin.end('')
})

if (skillExit.code === 0 || !/Provide one of/.test(skillExit.stderr)) {
  throw new Error(`Expected the skill script to reject empty input; got code ${skillExit.code}, stderr: ${skillExit.stderr}`)
}

console.log('Smoke test passed: VisionPower-Skill/describe_image.mjs rejects empty input.')

// Skill script: a successful provider call records the verified setup marker.
const tempDir = mkdtempSync(join(tmpdir(), 'visionpower-smoke-'))
try {
  const mockFetchPath = join(tempDir, 'mock-fetch.mjs')
  const statePath = join(tempDir, 'skill-state.json')
  const inboxDir = join(tempDir, 'inbox')
  const stagedImage = await stageImageBuffer(
    Buffer.from('GIF89a', 'ascii'),
    'image/gif',
    {
      maxImageBytes: 20 * 1024 * 1024,
      inbox: { dir: inboxDir, ttlMs: 30 * 60 * 1000, maxEntries: 4 },
    },
  )
  writeFileSync(mockFetchPath, `
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body)
  const structured = body.messages?.[0]?.role === 'system'
    && /Return ONLY JSON/i.test(body.messages[0].content)
  const content = structured
    ? '{"answer":"structured MCP ok","observations":["mocked"]}'
    : 'mocked skill ok'
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
`)

  // Structured mode remains backward-compatible text while exposing native
  // structuredContent for MCP clients that can consume it directly.
  const structuredTransport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', pathToFileURL(mockFetchPath).href, 'src/index.js'],
    env: {
      ...process.env,
      VISIONPOWER_API_KEY: 'test-key',
      VISIONPOWER_MODEL: 'test-model',
      VISIONPOWER_BASE_URL: 'https://api.example.com/v1',
      VISIONPOWER_CONFIG: join(tempDir, 'absent-mcp-config.json'),
      VISIONPOWER_INBOX_DIR: inboxDir,
    },
  })
  const structuredClient = new Client({
    name: 'visionpower-structured-smoke-test',
    version: '2.5.0',
  })
  try {
    await structuredClient.connect(structuredTransport)
    const structuredResult = await structuredClient.callTool({
      name: 'describe_image',
      arguments: {
        image_ref: stagedImage.id,
        output_format: 'structured',
      },
    })
    if (structuredResult.isError || structuredResult.structuredContent?.answer !== 'structured MCP ok') {
      throw new Error(`Expected native structuredContent; got ${JSON.stringify(structuredResult)}`)
    }
    const textEnvelope = JSON.parse(structuredResult.content?.[0]?.text || '{}')
    if (textEnvelope.answer !== 'structured MCP ok') {
      throw new Error(`Expected backward-compatible JSON text; got ${JSON.stringify(textEnvelope)}`)
    }
    console.log('Smoke test passed: structured MCP output includes structuredContent.')
  } finally {
    await structuredClient.close()
  }

  const skillSuccess = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import',
      pathToFileURL(mockFetchPath).href,
      'VisionPower-Skill/describe_image.mjs',
      '--image-ref',
      stagedImage.id,
    ], {
      env: {
        ...process.env,
        VISIONPOWER_API_KEY: 'test-key',
        VISIONPOWER_MODEL: 'test-model',
        VISIONPOWER_BASE_URL: 'https://api.example.com/v1',
        VISIONPOWER_CONFIG: join(tempDir, 'absent-config.json'),
        VISIONPOWER_SKILL_STATE: statePath,
        VISIONPOWER_INBOX_DIR: inboxDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })

  if (skillSuccess.code !== 0 || !/mocked skill ok/.test(skillSuccess.stdout)) {
    throw new Error(`Expected mocked skill success; got code ${skillSuccess.code}, stdout: ${skillSuccess.stdout}, stderr: ${skillSuccess.stderr}`)
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  if (state.configVerified !== true || state.model !== 'test-model') {
    throw new Error(`Expected verified skill state; got ${JSON.stringify(state)}`)
  }
  if (process.platform !== 'win32' && (statSync(statePath).mode & 0o777) !== 0o600) {
    throw new Error(`Expected skill state file mode 600; got ${(statSync(statePath).mode & 0o777).toString(8)}`)
  }
  console.log('Smoke test passed: VisionPower-Skill/describe_image.mjs records verified setup state.')

  const invalidStatePath = join(tempDir, 'invalid-skill-state.json')
  const invalidConfig = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'VisionPower-Skill/describe_image.mjs',
      '--image-base64',
      Buffer.from('GIF89a', 'ascii').toString('base64'),
    ], {
      env: {
        ...process.env,
        VISIONPOWER_API_KEY: 'test-key',
        VISIONPOWER_BASE_URL: 'file:///not-http',
        VISIONPOWER_CONFIG: join(tempDir, 'absent-config.json'),
        VISIONPOWER_SKILL_STATE: invalidStatePath,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr }))
  })
  if (invalidConfig.code === 0 || !/must use http or https/.test(invalidConfig.stderr)) {
    throw new Error(`Expected invalid config failure; got code ${invalidConfig.code}, stderr: ${invalidConfig.stderr}`)
  }
  const invalidState = JSON.parse(readFileSync(invalidStatePath, 'utf8'))
  if (invalidState.configVerified !== false || !/must use http or https/.test(invalidState.reason)) {
    throw new Error(`Expected invalid config to mark setup needed; got ${JSON.stringify(invalidState)}`)
  }
  console.log('Smoke test passed: VisionPower-Skill/describe_image.mjs records setup-needed state.')
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
