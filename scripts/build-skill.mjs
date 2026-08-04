#!/usr/bin/env node

// Generates the self-contained, zero-dependency skill script
// VisionPower-Skill/describe_image.mjs from the canonical core
// (src/config.js + src/vision-core.js). Run after changing the core:
//
//   npm run build:skill
//
// `npm test` fails if the committed file is out of sync, so the skill and the
// MCP server can never drift apart.

import { readFile, writeFile } from 'node:fs/promises'

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
  node describe_image.mjs request.json
  echo '<json request>' | node describe_image.mjs

The request JSON supports image_path / image_url / image_base64 / images[] / prompt / output_format.
Configure the API key in ~/.visionpower/config.json ({"apiKey":"...","model":"..."})
or via the VISIONPOWER_API_KEY environment variable. See SKILL.md for first-time setup.\`

function parseSkillArgs(argv) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { positionals.push(arg); continue }
    const eq = arg.indexOf('=')
    if (eq !== -1) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (key === 'help' || next === undefined || next.startsWith('--')) {
      flags[key] = true
    } else {
      flags[key] = next
      i += 1
    }
  }
  return { flags, positionals }
}

async function readSkillStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function resolveSkillRequest(argv) {
  const { flags, positionals } = parseSkillArgs(argv)
  if (flags.help) return { help: true }

  const fileArg = flags.input || positionals[0]
  if (fileArg) {
    return { request: JSON.parse(await readFile(fileArg, 'utf8')) }
  }

  const request = {}
  if (flags['image-path']) request.image_path = flags['image-path']
  if (flags['image-url']) request.image_url = flags['image-url']
  if (flags['image-base64']) request.image_base64 = flags['image-base64']
  if (flags.mime) request.image_mime_type = flags.mime
  if (flags.prompt) request.prompt = flags.prompt
  if (flags['output-format']) request.output_format = flags['output-format']

  if (request.image_path || request.image_url || request.image_base64) {
    return { request }
  }

  const raw = (await readSkillStdin()).trim()
  if (raw) return { request: JSON.parse(raw) }
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
  const core = stripModuleSyntax(await readFile(new URL('src/vision-core.js', ROOT), 'utf8'))
  // The skill entry point (MAIN above) has its own module dependencies that the
  // core sources are not guaranteed to share — declare them explicitly and merge
  // them in. Regression: `readFile` used to arrive "for free" via vision-core.js;
  // when the core dropped that import, the generated bundle lost it too and the
  // `--input <file>` / positional-JSON CLI path crashed with ReferenceError.
  const entryImports = stripModuleSyntax("import { readFile } from 'node:fs/promises'\n")
  const imports = mergeImports([config, core, entryImports]).join('\n')

  return `#!/usr/bin/env node

// AUTO-GENERATED — do not edit by hand.
// Source of truth: src/config.js + src/vision-core.js.
// Regenerate with: npm run build:skill

${imports}

${config.body}

${core.body}

${MAIN}`
}

const target = new URL('VisionPower-Skill/describe_image.mjs', ROOT)

if (process.argv.includes('--write')) {
  const script = await buildSkillScript()
  await writeFile(target, script)
  process.stdout.write(`Wrote ${target.pathname}\n`)
}
