#!/usr/bin/env node

// Generates the self-contained, zero-dependency skill script
// VisionPower-Skill/describe_image.mjs from the canonical core
// (src/config.js + src/image-inbox.js + src/vision-core.js). Run after changing the core:
//
//   npm run build:skill
//
// `npm test` fails if the committed file is out of sync, so the skill and the
// MCP server can never drift apart.

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)

// Parse an ES module source into (a) its import statements, decomposed into
// { names, module } pairs, and (b) the module body with `export ` prefixes
// stripped. Decomposing imports lets us merge the same specifier across the two
// source files (e.g. both import `stat` from node:fs/promises) without producing
// a duplicate-identifier SyntaxError in the generated skill script.
function stripModuleSyntax(source) {
  // Keep the generated artifact byte-identical on Windows and POSIX hosts.
  // Git may check source files out as CRLF depending on local configuration.
  source = source.replace(/\r\n?/g, '\n')
  const imports = []
  const bodyLines = []
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    const namedMatch = trimmed.match(/^import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]$/)
    if (namedMatch) {
      const names = namedMatch[1].split(',').map((n) => n.trim()).filter(Boolean)
      imports.push({ names, module: namedMatch[2] })
    } else if (/^import\s.+from\s.+$/.test(trimmed)) {
      // Fall back to a verbatim line for any import shape we don't decompose.
      imports.push({ raw: trimmed })
    } else {
      bodyLines.push(line.replace(/^export\s+/, ''))
    }
  }
  return { imports, body: bodyLines.join('\n').trim() }
}

// Merge imports from multiple sources, combining named imports that share the
// same module specifier while preserving first-seen order and de-duplicating
// identical names. Falls back to raw import lines for undecomposed statements.
function mergeImports(sources) {
  const byModule = new Map()
  const rawLines = []
  for (const { imports } of sources) {
    for (const entry of imports) {
      if (entry.raw) {
        if (!rawLines.includes(entry.raw)) rawLines.push(entry.raw)
        continue
      }
      // Relative imports connect the canonical source modules to each other.
      // Their bodies are concatenated below, so keeping those imports would
      // make the standalone Skill depend on files that are not installed next
      // to describe_image.mjs.
      if (entry.module.startsWith('.')) continue
      if (!byModule.has(entry.module)) byModule.set(entry.module, [])
      const existing = byModule.get(entry.module)
      for (const name of entry.names) {
        if (!existing.includes(name)) existing.push(name)
      }
    }
  }
  const merged = [...byModule.entries()].map(([module, names]) => {
    return `import { ${names.join(', ')} } from '${module}'`
  })
  return [...merged, ...rawLines]
}

const MAIN = `// ---- Skill entry point (self-contained; no install, no extra deps) ----

const HELP = \`VisionPower — understand images with a vision model.

Usage:
  node describe_image.mjs --image-path <absolute path> [--prompt <text>] [--output-format text|structured]
  node describe_image.mjs --image-url <https url> [--prompt <text>] [--output-format text|structured]
  node describe_image.mjs --image-ref <vpimg_...> [--prompt <text>] [--output-format text|structured]
  node describe_image.mjs request.json
  node describe_image.mjs --input request.json
  echo '<json request>' | node describe_image.mjs

The request JSON supports image_path / image_url / image_base64 / image_ref / images[] / prompt / output_format.
Configure the API key in ~/.visionpower/config.json ({"apiKey":"...","model":"..."})
or via the VISIONPOWER_API_KEY environment variable. See SKILL.md for first-time setup.\`

const MAX_SKILL_REQUEST_BYTES = 96 * 1024 * 1024
const SKILL_VALUE_FLAGS = new Set([
  'input', 'image-path', 'image-url', 'image-base64', 'image-ref',
  'mime', 'prompt', 'output-format',
])
const SKILL_BOOLEAN_FLAGS = new Set(['help'])

function parseSkillArgs(argv) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h') {
      if (flags.help !== undefined) throw new Error('Duplicate option: --help')
      flags.help = true
      continue
    }
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-')) throw new Error(\`Unknown option: \${arg}\`)
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const key = arg.slice(2, eq === -1 ? undefined : eq)
    if (!SKILL_VALUE_FLAGS.has(key) && !SKILL_BOOLEAN_FLAGS.has(key)) {
      throw new Error(\`Unknown option: --\${key}\`)
    }
    if (flags[key] !== undefined) throw new Error(\`Duplicate option: --\${key}\`)
    if (SKILL_BOOLEAN_FLAGS.has(key)) {
      if (eq !== -1) throw new Error(\`Option --\${key} does not take a value\`)
      flags[key] = true
      continue
    }
    if (eq !== -1) {
      const value = arg.slice(eq + 1)
      if (!value) throw new Error(\`Option --\${key} requires a value\`)
      flags[key] = value
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(\`Option --\${key} requires a value\`)
    }
    flags[key] = next
    i += 1
  }
  if (positionals.length > 1) throw new Error('Provide at most one request JSON file')
  return { flags, positionals }
}

async function readSkillStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  let totalBytes = 0
  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += data.length
    if (totalBytes > MAX_SKILL_REQUEST_BYTES) {
      throw new Error('Request JSON exceeds the 96MB safety limit')
    }
    chunks.push(data)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readSkillRequestFile(filePath) {
  // Open with O_NOFOLLOW on POSIX so a symlink swap cannot redirect the read,
  // mirroring readImageViaFd's hardening. The file path comes from the agent
  // (possibly via prompt injection), so reject symlinks rather than follow them.
  const noFollow = process.platform !== 'win32' ? fsConstants.O_NOFOLLOW : 0
  let handle
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow)
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error('Request JSON path must be a regular file, not a symbolic link')
    throw error
  }
  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) throw new Error('Request JSON path must be a regular file')
    if (fileStat.size > MAX_SKILL_REQUEST_BYTES) {
      throw new Error('Request JSON exceeds the 96MB safety limit')
    }
    const data = Buffer.allocUnsafe(fileStat.size)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return data.subarray(0, offset).toString('utf8')
  } finally {
    await handle.close()
  }
}

// Parse the request JSON without letting V8 echo file content back through the
// error message: a malformed or hijacked request file (e.g. an attacker tricks
// the agent into running \`describe_image.mjs ~/.ssh/id_rsa\`) would otherwise
// leak its leading bytes to stderr, where the agent can read and exfiltrate it.
function parseSkillRequestJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('Request is not valid JSON')
  }
}

async function resolveSkillRequest(argv) {
  const { flags, positionals } = parseSkillArgs(argv)
  if (flags.help) return { help: true }

  if (flags.input && positionals.length) {
    throw new Error('Provide the request JSON file either positionally or with --input, not both')
  }
  const fileArg = flags.input || positionals[0]
  if (fileArg) {
    const inlineFlags = [...SKILL_VALUE_FLAGS].filter((key) => key !== 'input' && flags[key] !== undefined)
    if (inlineFlags.length) {
      throw new Error('Do not combine a request JSON file with inline image, prompt, MIME, or output options')
    }
    return { request: parseSkillRequestJson(await readSkillRequestFile(fileArg)) }
  }

  const request = {}
  if (flags['image-path']) request.image_path = flags['image-path']
  if (flags['image-url']) request.image_url = flags['image-url']
  if (flags['image-base64']) request.image_base64 = flags['image-base64']
  if (flags['image-ref']) request.image_ref = flags['image-ref']
  if (flags.mime) request.image_mime_type = flags.mime
  if (flags.prompt) request.prompt = flags.prompt
  if (flags['output-format']) request.output_format = flags['output-format']

  if (request.image_path || request.image_url || request.image_base64 || request.image_ref) {
    return { request }
  }

  const raw = (await readSkillStdin()).trim()
  if (raw) return { request: parseSkillRequestJson(raw) }
  return { request }
}

async function mainSkill() {
  let resolved
  try {
    resolved = await resolveSkillRequest(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(\`VisionPower error: could not read request: \${error.message}\\n\`)
    process.exitCode = 1
    return
  }

  if (resolved.help) {
    process.stdout.write(\`\${HELP}\\n\`)
    return
  }

  try {
    const config = loadVisionConfig(process.env)
    const text = await describeImage(resolved.request, config)
    // Record that the Skill setup has successfully reached the provider. This
    // marker is intentionally best-effort: image analysis should never fail just
    // because the agent cannot write local state.
    await markSkillConfigVerified(config, process.env).catch(() => {})
    process.stdout.write(\`\${text}\\n\`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isLikelySkillSetupError(message)) {
      await markSkillConfigNeedsSetup(message, process.env).catch(() => {})
    }
    process.stderr.write(\`VisionPower error: \${message}\\n\`)
    process.exitCode = 1
  }
}

function isLikelySkillSetupError(message) {
  return /not configured|config file|VISIONPOWER_|OPENAI_API_KEY|base\\s*url|unauthori[sz]ed|forbidden|invalid[^\\n]*(api|key|token)|authentication|permission denied|\\b401\\b|\\b403\\b/i.test(message)
}

mainSkill()
`

export async function buildSkillScript() {
  const config = stripModuleSyntax(await readFile(new URL('src/config.js', ROOT), 'utf8'))
  const inbox = stripModuleSyntax(await readFile(new URL('src/image-inbox.js', ROOT), 'utf8'))
  const core = stripModuleSyntax(await readFile(new URL('src/vision-core.js', ROOT), 'utf8'))
  // The skill entry point (MAIN above) has its own module dependencies that the
  // core sources are not guaranteed to share — declare them explicitly and merge
  // them in. Keeping `open` and `fsConstants` here prevents the positional /
  // --input JSON path (which now opens with O_NOFOLLOW) from breaking if a
  // future core refactor no longer imports them itself.
  const entryImports = stripModuleSyntax(
    "import { open } from 'node:fs/promises'\n" +
    "import { constants as fsConstants } from 'node:fs'\n",
  )
  const imports = mergeImports([config, inbox, core, entryImports]).join('\n')

  return `#!/usr/bin/env node

// AUTO-GENERATED — do not edit by hand.
// Source of truth: src/config.js + src/image-inbox.js + src/vision-core.js.
// Regenerate with: npm run build:skill

${imports}

${config.body}

${inbox.body}

${core.body}

${MAIN}`
}

const target = new URL('VisionPower-Skill/describe_image.mjs', ROOT)

if (process.argv.includes('--write')) {
  const script = await buildSkillScript()
  await writeFile(target, script)
  process.stdout.write(`Wrote ${fileURLToPath(target)}\n`)
}
