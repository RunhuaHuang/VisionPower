// Shared helpers for bundling the canonical VisionPower core
// (src/config.js + src/image-inbox.js + src/vision-core.js) into standalone
// artifacts. Used by scripts/build-skill.mjs (zero-dependency Skill script)
// and scripts/build-dsh.mjs (dsh Cordis plugin core bundle), so both
// generated forms are built from the exact same code path and can never drift
// apart in structure.

// Parse an ES module source into (a) its import statements, decomposed into
// { names, module } pairs, and (b) the module body with `export ` prefixes
// stripped. Decomposing imports lets us merge the same specifier across
// multiple source files (e.g. both import `stat` from node:fs/promises)
// without producing a duplicate-identifier SyntaxError in the generated file.
export function stripModuleSyntax(source) {
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
export function mergeImports(sources) {
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
      // make the standalone bundle depend on files that are not installed
      // next to it.
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
