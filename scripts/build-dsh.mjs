#!/usr/bin/env node

// Generates the self-contained core bundle for the dsh Cordis plugin
// (src/dsh/core.bundle.js) from the canonical core
// (src/config.js + src/image-inbox.js + src/vision-core.js). Run after
// changing the core:
//
//   npm run build:dsh
//
// `npm test` fails if the committed file is out of sync, so the dsh plugin,
// the MCP server, and the standalone Skill can never drift apart.

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { mergeImports, stripModuleSyntax } from './bundle-core-lib.mjs'

const REPO_ROOT = new URL('../', import.meta.url)
const PLUGIN_SRC = new URL('src/dsh/', REPO_ROOT)

export async function buildDshCoreBundle() {
  const config = stripModuleSyntax(await readFile(new URL('src/config.js', REPO_ROOT), 'utf8'))
  const inbox = stripModuleSyntax(await readFile(new URL('src/image-inbox.js', REPO_ROOT), 'utf8'))
  const core = stripModuleSyntax(await readFile(new URL('src/vision-core.js', REPO_ROOT), 'utf8'))
  const imports = mergeImports([config, inbox, core]).join('\n')

  return `// AUTO-GENERATED — do not edit by hand.
// Source of truth: src/config.js + src/image-inbox.js + src/vision-core.js.
// Regenerate with: npm run build:dsh

${imports}

${config.body}

${inbox.body}

${core.body}

export {
  describeImage,
  loadVisionConfig,
  resolveModelCapabilities,
  testModelConnection,
}
`
}

const target = new URL('core.bundle.js', PLUGIN_SRC)

if (process.argv.includes('--write')) {
  const bundle = await buildDshCoreBundle()
  await writeFile(target, bundle)
  process.stdout.write(`Wrote ${fileURLToPath(target)}\n`)
}

if (process.argv.includes('--check')) {
  const bundle = await buildDshCoreBundle()
  const committed = await readFile(target, 'utf8').catch(() => '')
  if (bundle !== committed.replace(/\r\n?/g, '\n')) {
    process.stderr.write('src/dsh/core.bundle.js is out of date; run `npm run build:dsh`\n')
    process.exitCode = 1
  } else {
    process.stdout.write('src/dsh/core.bundle.js is up to date\n')
  }
}
