#!/usr/bin/env node
// setup-dsh.mjs —— VisionPower 一键安装到 dsh（DeepSeek Harness）
//
// 目标用户：已经装了 dsh 的人。本脚本不负责安装 dsh 本身。
//
// 用法：
//   node scripts/setup-dsh.mjs                     # 安装+配置（①–⑥）
//   node scripts/setup-dsh.mjs --launch            # 安装+配置+启动 dsh web（①–⑦）
//   node scripts/setup-dsh.mjs --write-agents      # 同时把识图规则追加到 ~/.dsh/AGENTS.md
//   node scripts/setup-dsh.mjs --check             # 只验证现状，不改任何东西
//   node scripts/setup-dsh.mjs --profile <name>    # 目标 profile（默认 web）
//   node scripts/setup-dsh.mjs --plugin-source <spec>  # 插件源（默认当前精确版本）
//   node scripts/setup-dsh.mjs --no-console        # 跳过启动 VisionPower 配置控制台
//   node scripts/setup-dsh.mjs --wait-secs <n>     # 等待用户配置控制台的最长秒数（默认 180）
//
// 所有步骤幂等，可反复重跑。dsh 升级 / npx 重装后补丁会消失，重跑本脚本自动重打。
// 本脚本只用 Node 内置模块，不依赖任何第三方包。

import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { request as httpRequest } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version
const PATCH_SCRIPT = path.join(HERE, 'patch-dsh.mjs')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, '.visionpower-state.json')
const AGENTS_FILE = path.join(DSH_HOME, 'AGENTS.md')
const VISIONPOWER_CONFIG = process.env.VISIONPOWER_CONFIG || path.join(os.homedir(), '.visionpower', 'config.json')
const DEFAULT_PLUGIN_SOURCE = `visionpower@${PKG_VERSION}`
const CORDIS_ROW =
  `- insert:\n` +
  `    - id: visionpower\n` +
  `      name: 'visionpower/dsh'\n` +
  `      config:            # 全部可选，不写则沿用 ~/.visionpower/config.json 与环境变量\n` +
  `        timeoutMs: 120000\n`

const log = (msg) => process.stdout.write(`[setup-dsh] ${msg}\n`)
const warn = (msg) => process.stdout.write(`[setup-dsh] ⚠ ${msg}\n`)

// Windows 上 pnpm/dsh/npx/npm/corepack 都是 .cmd shim，必须经 shell 启动；
// node 等真实可执行文件不需要 shell（shell 拼接会把含空格的路径参数搞坏）。
const IS_WIN = process.platform === 'win32'
function shimOpts(extra = {}) {
  return IS_WIN ? { shell: true, ...extra } : extra
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.error) throw r.error
  return r
}

// 专门用于 .cmd shim 命令（pnpm/dsh/npx/npm/corepack）的包装
function runShim(cmd, args, opts = {}) {
  return run(cmd, args, shimOpts(opts))
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  fs.renameSync(temp, file)
}

function sha256Of(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function portListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    sock.setTimeout(800)
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
    sock.once('error', () => resolve(false))
  })
}

function probeConsoleIdentity(port, {
  expectedVersion = PKG_VERSION,
  expectedConfigPath = VISIONPOWER_CONFIG,
  timeoutMs = 1500,
} = {}) {
  return new Promise((resolveProbe, rejectProbe) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/identity',
      method: 'GET',
      headers: { Accept: 'application/json', Host: `127.0.0.1:${port}` },
    }, (res) => {
      const chunks = []
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 64 * 1024) {
          req.destroy(new Error('identity response is too large'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          rejectProbe(new Error(`HTTP ${res.statusCode ?? 'unknown'}`))
          return
        }
        let identity
        try {
          identity = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          rejectProbe(new Error('identity response is not valid JSON'))
          return
        }
        if (identity?.product !== 'visionpower' || identity?.protocolVersion !== 1) {
          rejectProbe(new Error('listener is not a compatible VisionPower console'))
          return
        }
        if (expectedVersion && identity.version !== expectedVersion) {
          rejectProbe(new Error(`VisionPower version is ${identity.version ?? 'unknown'}, expected ${expectedVersion}`))
          return
        }
        if (expectedConfigPath && identity.configPath !== expectedConfigPath) {
          rejectProbe(new Error(`console uses a different config: ${identity.configPath ?? 'unknown'}`))
          return
        }
        resolveProbe(identity)
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('identity probe timed out')))
    req.once('error', rejectProbe)
    req.end()
  })
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function openBrowser(url) {
  const platform = process.platform
  try {
    if (platform === 'darwin') { execFileSync('open', [url], { stdio: 'ignore' }) }
    else if (platform === 'win32') { execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' }) }
    else { execFileSync('xdg-open', [url], { stdio: 'ignore' }) }
    return true
  } catch {
    return false
  }
}

function profileDir(profile) {
  return path.join(DSH_HOME, 'profiles', profile)
}

function visionConfigHasKey() {
  const cfg = readJson(VISIONPOWER_CONFIG)
  return Boolean(cfg && typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 装插件
// ─────────────────────────────────────────────────────────────────────────────

function installedPluginVersion(dir) {
  const pkg = readJson(path.join(dir, 'node_modules', 'visionpower', 'package.json'))
  return pkg?.version ?? null
}

// 简单 semver 比较（数字段 + rc 预发布），够用即可
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split('-')
    return { core: core.split('.').map((n) => parseInt(n, 10) || 0), pre }
  }
  const comparePre = (pa, pb) => {
    if (!pa && !pb) return 0
    if (!pa) return 1 // 无预发布 > 有预发布
    if (!pb) return -1
    const sa = pa.split('.')
    const sb = pb.split('.')
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
      const x = sa[i]
      const y = sb[i]
      if (x === y) continue
      if (x === undefined) return -1
      if (y === undefined) return 1
      const nx = Number(x)
      const ny = Number(y)
      // 数字段按数值比（rc.10 > rc.6），其余按字符串
      if (Number.isFinite(nx) && Number.isFinite(ny)) return nx < ny ? -1 : 1
      return x < y ? -1 : 1
    }
    return 0
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const x = pa.core[i] ?? 0
    const y = pb.core[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return comparePre(pa.pre, pb.pre)
}

export function parsePatchedInstallations(output) {
  return String(output).split(/\n== 安装位置: /).slice(1).flatMap((block) => {
    const newline = block.indexOf('\n')
    if (newline < 0) return []
    const root = block.slice(0, newline).trim()
    const version = block.match(/dsh 版本: ([^\s（(]+)/)?.[1]?.trim()
    return root && version ? [{ root, version }] : []
  })
}

function ensurePnpm() {
  try {
    runShim('pnpm', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function validatePluginSource(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('--plugin-source 不能为空')
  const value = source.trim()
  if (/[\r\n\0&|;<>`$()^%!]/.test(value)) {
    throw new Error('--plugin-source 含不允许的 shell 元字符')
  }
  const exactNpm = /^visionpower@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
  const pinnedGithub = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#(?:[0-9a-fA-F]{40}|v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/
  const localFile = /^file:(?:\/{1,3}|[A-Za-z]:[\\/]).+$/
  if (!exactNpm.test(value) && !pinnedGithub.test(value) && !localFile.test(value)) {
    throw new Error('--plugin-source 必须是 visionpower@精确版本、固定 Git tag/commit，或绝对 file: 路径')
  }
  return value
}

function pnpmMajor() {
  try {
    const r = runShim('pnpm', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    return Number(String(r.stdout).trim().split('.')[0]) || 0
  } catch {
    return 0
  }
}

function installPluginViaPnpm(dir, source) {
  if (!ensurePnpm()) {
    throw new Error('pnpm 不可用。安装器不会自动修改全局包管理器；请先安装或启用 pnpm，再重试。')
  }
  const major = pnpmMajor()
  if (major > 0 && major < 7) {
    throw new Error(`pnpm 版本过旧（${major}.x），需要 >= 7。请自行升级 pnpm 后重试。`)
  }
  log(`用 pnpm 安装/更新插件到 ${dir}`)
  // pnpm 会按同一 file: spec + package version 复用旧的导入快照；本地开发覆盖
  // 必须强制重新导入，才能把新增/删除的文件同步到 profile。
  const args = ['--dir', dir, 'add']
  if (source.startsWith('file:')) args.push('--force')
  args.push(source)
  const r = runShim('pnpm', args, { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('pnpm add 失败，请查看上方输出。')
}

function syncLocalDshClientMetadata(dir, source) {
  if (!source.startsWith('file:')) return
  const sourceRoot = fileURLToPath(source)
  const from = path.join(sourceRoot, 'src', 'dsh', 'package.json')
  if (!fs.existsSync(from)) return

  // pnpm 的 directory dependency 采用硬链接导入：既有文件会随工作区更新，
  // 但同版本下新增的文件不会补进已导入目录。rc.7 的客户端扫描恰好需要
  // 这个新增子路径元数据，因此在本地开发覆盖后原子补齐它。
  const to = path.join(dir, 'node_modules', 'visionpower', 'src', 'dsh', 'package.json')
  fs.mkdirSync(path.dirname(to), { recursive: true })
  const temp = `${to}.${process.pid}.${Date.now()}.tmp`
  fs.copyFileSync(from, temp, fs.constants.COPYFILE_EXCL)
  fs.renameSync(temp, to)
}

function installPlugin(profile, source) {
  const dir = profileDir(profile)
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`profile 目录不存在：${dir}（请先运行过一次 dsh web）`)
  }
  const current = installedPluginVersion(dir)
  const localDevelopmentSource = source.startsWith('file:')
  if (current) {
    const cmp = compareVersions(current, PKG_VERSION)
    if (cmp === 0 && !localDevelopmentSource) {
      log(`插件已安装且版本一致（visionpower@${current}），跳过`)
      return { status: 'skip', version: current }
    }
    if (cmp > 0 && !localDevelopmentSource) {
      log(`插件已安装且版本更新（visionpower@${current} > 本脚本 ${PKG_VERSION}），跳过`)
      return { status: 'skip', version: current }
    }
    if (localDevelopmentSource) log(`使用本地 file: 源覆盖安装 visionpower@${current}`)
    else log(`插件版本较旧（visionpower@${current} → ${PKG_VERSION}），升级`)
  }

  // 优先走 dsh 官方插件命令；该命令在部分 dsh 版本中不存在，失败则兜底 pnpm。
  // 探测要求 help 同时出现 plugin 与 --profile，避免误中其他同名 dsh 工具（如 Debian 的 distributed shell）。
  try {
    const probe = runShim('dsh', ['--help'], { stdio: ['ignore', 'pipe', 'pipe'] })
    if (probe.status === 0 && probe.stdout.includes('plugin') && probe.stdout.includes('--profile')) {
      log(`用 dsh plugin 命令安装 ${source}`)
      const r = runShim('dsh', ['plugin', '--profile', profile, 'add', source], { stdio: 'inherit' })
      if (r.status === 0) {
        syncLocalDshClientMetadata(dir, source)
        return { status: current ? 'upgraded' : 'installed', version: installedPluginVersion(dir) }
      }
      warn('dsh plugin 命令执行失败，改用 pnpm 兜底')
    }
  } catch { /* dsh 命令不存在或不可用，走 pnpm */ }

  installPluginViaPnpm(dir, source)
  syncLocalDshClientMetadata(dir, source)
  return { status: current ? 'upgraded' : 'installed', version: installedPluginVersion(dir) }
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 挂载 cordis
// ─────────────────────────────────────────────────────────────────────────────

// 把 visionpower 的 insert 行合并进既有 cordis.patch.yml 内容（纯函数，便于测试）：
// dsh 生成的默认文件是「注释 + 独立一行的空数组 []」，空数组是流式节点，其后不能
// 直接续块序列（否则 YAML 解析失败、整个 profile 起不来），先把独立的 [] 行剥掉再追加。
export function composeCordisContent(content) {
  const stripped = content.replace(/^[ \t]*\[\][ \t]*\r?$/m, '')
  const addition = (stripped.length > 0 && !stripped.endsWith('\n') ? '\n' : '') + (stripped.length > 0 ? '\n' : '') + CORDIS_ROW
  return stripped + addition
}

function mountCordis(profile) {
  const dir = profileDir(profile)
  const file = path.join(dir, 'cordis.patch.yml')
  let content = ''
  if (fs.existsSync(file)) content = fs.readFileSync(file, 'utf8')
  if (content.includes("name: 'visionpower/dsh'") || content.includes('name: "visionpower/dsh"')) {
    log(`cordis.patch.yml 已挂载 visionpower/dsh，跳过`)
    return { status: 'skip' }
  }
  fs.mkdirSync(dir, { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, composeCordisContent(content), { flag: 'wx' })
  fs.renameSync(temp, file)
  log(`已挂载 visionpower/dsh -> ${file}`)
  return { status: 'mounted' }
}
// ③ 打补丁 + 状态追踪
// ─────────────────────────────────────────────────────────────────────────────

const PATCH_PACKAGES = ['dsh-host-apiproxy', 'dsh-llm-deepseek', 'dsh-llm-pi-ai']

function hashPatchTargets(root) {
  const out = {}
  for (const pkg of PATCH_PACKAGES) {
    const dir = path.join(root, '@deepseek-ai', pkg)
    if (!fs.existsSync(dir)) continue
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) }
        else if (e.name.endsWith('.js') && !e.name.endsWith('.map')) {
          out[path.relative(root, p)] = sha256Of(p)
        }
      }
    }
    walk(dir)
  }
  return out
}

function runPatchScript(args) {
  return run(process.execPath, [PATCH_SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
}

function patchStep() {
  // 自测：结构不匹配必须第一时间暴露
  log('补丁自测…')
  const selfTest = runPatchScript(['--self-test'])
  process.stdout.write(selfTest.stdout)
  process.stderr.write(selfTest.stderr)
  if (selfTest.status !== 0 || !selfTest.stdout.includes('SELF-TEST PASS')) {
    throw new Error('补丁脚本自测 FAIL——dsh 版本可能已更新，patch-dsh.mjs 需要升级。请将上面的报错原样转告用户，不要继续。')
  }

  // 打补丁（幂等）
  log('应用补丁…')
  const patch = runPatchScript([])
  process.stdout.write(patch.stdout)
  process.stderr.write(patch.stderr)

  // 解析关键信息
  const summaryMatch = patch.stdout.match(/结构不匹配 (\d+) 处，语法失败 (\d+) 处/)
  const appliedMatch = patch.stdout.match(/应用补丁 (\d+) 处/)
  const installations = parsePatchedInstallations(`\n${patch.stdout}`)
  const selected = installations.reduce((best, item) => (
    !best || compareVersions(item.version, best.version) > 0 ? item : best
  ), null)
  const root = selected?.root
  const dshVersion = selected?.version
  const structureFail = summaryMatch ? Number(summaryMatch[1]) : null
  const syntaxFail = summaryMatch ? Number(summaryMatch[2]) : null
  const applied = appliedMatch ? Number(appliedMatch[1]) : 0

  if (patch.status !== 0 || structureFail === null || structureFail > 0 || syntaxFail > 0) {
    throw new Error('补丁未完全成功（结构不匹配/语法失败 > 0），请按上方 ✗ 提示处理后再重试。')
  }

  // 状态追踪：记录 dsh 版本 + 目标文件哈希
  const state = readJson(STATE_FILE) ?? {}
  const hashes = root ? hashPatchTargets(root) : {}
  const prev = state.dshVersion
  state.dshVersion = dshVersion ?? null
  state.dshRoot = root ?? null
  state.patchTargetHashes = hashes
  state.visionpowerVersion = PKG_VERSION
  state.patchedAt = new Date().toISOString()
  writeJson(STATE_FILE, state)
  if (prev && prev !== dshVersion) {
    log(`检测到 dsh 从 ${prev} 升级到 ${dshVersion}，补丁已自动重打 ✓`)
  } else {
    log(`补丁状态已记录（dsh ${dshVersion ?? '?'}）→ ${STATE_FILE}`)
  }
  return { root, dshVersion, applied }
}

function patchCheck() {
  // --check 模式：跑一遍补丁探测（dry-run，绝不写入），用其输出作为现状
  const selfTest = runPatchScript(['--self-test'])
  process.stdout.write(selfTest.stdout)
  process.stderr.write(selfTest.stderr)
  if (selfTest.status !== 0 || !selfTest.stdout.includes('SELF-TEST PASS')) {
    return { ok: false, reason: '补丁自测 FAIL（dsh 结构可能已变化）' }
  }
  const patch = runPatchScript(['--dry-run'])
  process.stdout.write(patch.stdout)
  process.stderr.write(patch.stderr)
  const summaryMatch = patch.stdout.match(/结构不匹配 (\d+) 处，语法失败 (\d+) 处/)
  const structureFail = summaryMatch ? Number(summaryMatch[1]) : null
  const syntaxFail = summaryMatch ? Number(summaryMatch[2]) : null
  return { ok: patch.status === 0 && structureFail === 0 && syntaxFail === 0 }
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ 识图规则 → ~/.dsh/AGENTS.md（仅 --write-agents）
// ─────────────────────────────────────────────────────────────────────────────

async function writeAgentsRules() {
  let content = ''
  if (fs.existsSync(AGENTS_FILE)) content = fs.readFileSync(AGENTS_FILE, 'utf8')
  const { RULES_TEXT, upsertVisionPowerRules } = await loadRulesModule()
  const result = upsertVisionPowerRules(content, RULES_TEXT)
  if (result.status === 'current') {
    log(`~/.dsh/AGENTS.md 已包含当前版本的 VisionPower 识图规则，跳过`)
    return { status: 'skip' }
  }
  fs.mkdirSync(path.dirname(AGENTS_FILE), { recursive: true })
  fs.writeFileSync(AGENTS_FILE, result.content)
  if (result.status === 'updated') log(`已把 ${AGENTS_FILE} 中的旧版识图规则升级为当前版本`)
  else log(`已把识图规则追加到 ${AGENTS_FILE}`)
  return { status: result.status === 'updated' ? 'updated' : 'written' }
}

function agentsFileHasVisionPowerRules() {
  try {
    const content = fs.readFileSync(AGENTS_FILE, 'utf8')
    return content.includes('图片的定位与识图规则（VisionPower）')
      || /<!-- visionpower:dsh-rules:v\d+ -->/.test(content)
  } catch {
    return false
  }
}

// 规则文本与插件注入共用同一份（src/dsh/rules.js），直接 import 模块，避免文本解析
async function loadRulesModule() {
  return import(pathToFileURL(path.join(HERE, '..', 'src', 'dsh', 'rules.js')).href)
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ VisionPower 配置控制台
// ─────────────────────────────────────────────────────────────────────────────

async function ensureConsole(profile, noConsole, waitSecs, forceConsole) {
  if (noConsole) {
    if (!visionConfigHasKey()) warn('跳过控制台启动；但 ~/.visionpower/config.json 尚无 API key，识图会失败')
    return { status: 'skipped' }
  }
  const PORT = 17900
  const expectedVersion = installedPluginVersion(profileDir(profile)) || PKG_VERSION
  let spawned = false
  if (await portListening(PORT)) {
    try {
      await probeConsoleIdentity(PORT, { expectedVersion })
    } catch (error) {
      throw new Error(`端口 ${PORT} 已被占用，但不是当前安装所需的 VisionPower 配置控制台：${error.message}。请关闭占用该端口的旧实例或其他程序后重试。`)
    }
    log(`已验证 VisionPower 配置控制台正在运行 http://127.0.0.1:${PORT}，跳过启动`)
    if (!visionConfigHasKey()) warn('控制台在运行但 ~/.visionpower/config.json 尚无 API key')
  } else if (visionConfigHasKey() && !forceConsole) {
    // 复跑场景（如新增/更换模型后重跑）：配置已就绪就不再拉起常驻进程；
    // 需要调整视觉模型/API Key 时用 --console 强制启动。
    log('VisionPower 已配置（~/.visionpower/config.json 含 API key），跳过启动配置控制台（如需调整视觉模型/API Key，加 --console 强制启动）')
    return { status: 'configured' }
  } else {
    // 用 node 直接跑包内 src/index.js，避免平台相关的 .bin shim（visionpower(.cmd/.ps1)）；
    // node 是真实可执行文件，不加 shell（避免路径含空格时被 shell 拆分）
    const bin = path.join(profileDir(profile), 'node_modules', 'visionpower', 'src', 'index.js')
    const logFile = path.join(DSH_HOME, '.visionpower-console.log')
    const child = fs.existsSync(bin)
      ? spawn(process.execPath, [bin, '--webui'], { detached: true, stdio: ['ignore', 'ignore', fs.openSync(logFile, 'a')] })
      : spawn('npx', ['-y', '--package', `visionpower@${PKG_VERSION}`, 'visionpower', '--webui'], shimOpts({ detached: true, stdio: ['ignore', 'ignore', fs.openSync(logFile, 'a')] }))
    child.unref()
    spawned = true
    log(`已启动 VisionPower 配置控制台 → http://127.0.0.1:${PORT}（日志 ${logFile}）`)
  }

  // 等身份端点真正就绪再弹浏览器；仅端口可连接不足以证明进程、版本和
  // 配置路径正确。
  const budgetMs = spawned ? 30000 : 3000
  const readyDeadline = Date.now() + budgetMs
  let identityReady = false
  do {
    try {
      await probeConsoleIdentity(PORT, { expectedVersion })
      identityReady = true
    } catch {
      if (Date.now() < readyDeadline) await sleep(500)
    }
  } while (!identityReady && Date.now() < readyDeadline)
  if (identityReady) {
    if (openBrowser(`http://127.0.0.1:${PORT}`)) log(`已在浏览器打开 http://127.0.0.1:${PORT}`)
  } else {
    warn(`配置控制台 ${Math.round(budgetMs / 1000)}s 内未就绪（日志 ${path.join(DSH_HOME, '.visionpower-console.log')}），请稍后手动访问 http://127.0.0.1:${PORT}`)
  }

  if (visionConfigHasKey()) {
    log('VisionPower 已配置（~/.visionpower/config.json 含 API key）✓')
    return { status: 'configured' }
  }
  log(`请在 CONFIG 页选择视觉模型预设、粘贴 API Key、点「保存并应用配置」。`)
  const deadline = Date.now() + waitSecs * 1000
  while (Date.now() < deadline) {
    await sleep(3000)
    if (visionConfigHasKey()) {
      log('已检测到配置保存 ✓')
      return { status: 'configured' }
    }
  }
  throw new Error(`等待 ${waitSecs}s 仍未检测到 ~/.visionpower/config.json 的 API key。请先在控制台完成配置，再重跑本脚本。`)
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 启动 dsh web
// ─────────────────────────────────────────────────────────────────────────────

async function launchDshWeb() {
  const PORT = 3080
  let status = 'already-running'
  if (await portListening(PORT)) {
    log(`dsh web 已在运行 http://127.0.0.1:${PORT}，跳过启动（直接打开浏览器）`)
  } else {
    status = 'started'
    const logFile = path.join(DSH_HOME, '.visionpower-dsh-web.log')
    const state = readJson(STATE_FILE)
    const recordedBin = state?.dshRoot
      ? path.join(state.dshRoot, '.bin', IS_WIN ? 'dsh.cmd' : 'dsh')
      : null
    const stdio = ['ignore', 'ignore', fs.openSync(logFile, 'a')]
    // patchStep has already selected and verified the newest compatible dsh
    // installation. Launch that exact patched binary instead of asking npm to
    // resolve/install the package again, which can be slow, hang offline, or
    // select a different unpatched cache entry.
    const child = recordedBin && fs.existsSync(recordedBin)
      ? spawn(recordedBin, ['web'], shimOpts({ detached: true, stdio }))
      : spawn('npx', ['-y', `@deepseek-ai/dsh@${state?.dshVersion || '0.1.0-rc.7'}`, 'web'], shimOpts({ detached: true, stdio }))
    child.unref()
    log(`正在启动 dsh web${recordedBin && fs.existsSync(recordedBin) ? `（已验证二进制 ${recordedBin}）` : ''}（日志 ${logFile}）…`)
    const deadline = Date.now() + 60000
    let up = false
    while (Date.now() < deadline) {
      await sleep(2000)
      if (await portListening(PORT)) { up = true; break }
    }
    if (!up) warn('60s 内 dsh web 未就绪，请查看日志文件；稍后手动访问 http://127.0.0.1:3080')
  }
  if (openBrowser(`http://127.0.0.1:${PORT}`)) {
    log(`已在浏览器打开 http://127.0.0.1:${PORT}`)
  } else {
    log(`请手动在浏览器打开 http://127.0.0.1:${PORT}`)
  }
  return { status }
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

const USAGE = `VisionPower setup-dsh v${PKG_VERSION} —— 一键安装/配置 VisionPower 到 dsh（DeepSeek Harness）

用法：
  node scripts/setup-dsh.mjs [选项]

选项：
  --launch            完成后自动启动 dsh web 并打开浏览器
  --write-agents      同时把识图规则追加到 ~/.dsh/AGENTS.md（默认由插件运行时注入）
  --check             只验证现状（插件/cordis/补丁/API key），不改任何东西
  --profile <name>    目标 profile（默认 web）
  --plugin-source <spec>  插件源（默认 visionpower@${PKG_VERSION}；仅接受精确版本、固定 Git tag/commit 或绝对 file: 路径）
  --console           强制启动 VisionPower 配置控制台（默认仅在尚未配置 API key 时启动）
  --no-console        跳过启动 VisionPower 配置控制台
  --wait-secs <n>     等待用户完成控制台配置的最长秒数（默认 180）
  --help, -h          显示本帮助

流程：① 装插件 → ② 挂载 cordis → ③ 打补丁+状态追踪 → ④ 规则（--write-agents）
      → ⑤ 配置控制台 → ⑥ 验证 → ⑦ 启动 dsh web（--launch）

所有步骤幂等，可反复重跑；dsh 升级后重跑即可自动重打补丁。
`

function parseArgs(argv) {
  const parsed = {
    launch: false, writeAgents: false, check: false, noConsole: false, forceConsole: false, help: false,
    profile: 'web', pluginSource: DEFAULT_PLUGIN_SOURCE, waitSecs: 180,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--launch') parsed.launch = true
    else if (a === '--write-agents') parsed.writeAgents = true
    else if (a === '--check') parsed.check = true
    else if (a === '--console') parsed.forceConsole = true
    else if (a === '--no-console') parsed.noConsole = true
    else if (a === '--help' || a === '-h') parsed.help = true
    else if (a === '--profile') { parsed.profile = argv[++i]; if (!parsed.profile) throw new Error('--profile 需要一个值') }
    else if (a.startsWith('--profile=')) parsed.profile = a.slice('--profile='.length)
    else if (a === '--plugin-source') { parsed.pluginSource = argv[++i]; if (!parsed.pluginSource) throw new Error('--plugin-source 需要一个值') }
    else if (a.startsWith('--plugin-source=')) parsed.pluginSource = a.slice('--plugin-source='.length)
    else if (a === '--wait-secs') { parsed.waitSecs = Number(argv[++i]); if (!Number.isFinite(parsed.waitSecs) || parsed.waitSecs <= 0) throw new Error('--wait-secs 需要正整数') }
    else if (a.startsWith('--wait-secs=')) { parsed.waitSecs = Number(a.slice('--wait-secs='.length)); if (!Number.isFinite(parsed.waitSecs) || parsed.waitSecs <= 0) throw new Error('--wait-secs 需要正整数') }
    else throw new Error(`未知参数：${a}（--help 查看用法）`)
  }
  return parsed
}

export async function main(argv = process.argv.slice(2)) {
  let args
  try { args = parseArgs(argv) } catch (e) {
    process.stderr.write(`[setup-dsh] ${e.message}\n`)
    process.exitCode = 1
    return
  }

  if (args.help) {
    console.log(USAGE)
    return
  }

  // profile 名用于拼路径，禁止路径穿越/非法字符
  if (!/^[A-Za-z0-9_-]+$/.test(args.profile)) {
    process.stderr.write(`[setup-dsh] 非法的 profile 名：${args.profile}（仅允许字母、数字、_、-）\n`)
    process.exitCode = 1
    return
  }

  try {
    args.pluginSource = validatePluginSource(args.pluginSource)
  } catch (error) {
    process.stderr.write(`[setup-dsh] ${error.message}\n`)
    process.exitCode = 1
    return
  }

  console.log(`VisionPower setup-dsh v${PKG_VERSION}（DSH_HOME: ${DSH_HOME}，profile: ${args.profile}）`)

  if (args.check) {
    log('── 验证模式（--check，不改任何东西）──')
    const cordisOk = (() => {
      const file = path.join(profileDir(args.profile), 'cordis.patch.yml')
      return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('visionpower/dsh')
    })()
    const pluginVersion = installedPluginVersion(profileDir(args.profile))
    const patch = patchCheck()
    const state = readJson(STATE_FILE)
    log(`插件: ${pluginVersion ?? '未安装'}`)
    if (pluginVersion && pluginVersion !== PKG_VERSION) {
      warn(`插件版本（${pluginVersion}）与本脚本（${PKG_VERSION}）不一致，重跑安装可同步`)
    }
    log(`cordis 挂载: ${cordisOk ? '✓' : '✗ 未挂载'}`)
    log(`补丁: ${patch.ok ? '✓ 全部已打过' : `✗ ${patch.reason ?? '存在问题'}`}`)
    log(`VisionPower 配置: ${visionConfigHasKey() ? '✓ 已配置 API key' : '✗ 未配置（需启动配置控制台）'}`)
    if (state?.dshVersion) log(`状态追踪: 上次补丁记录 dsh ${state.dshVersion}（${state.patchedAt}）`)
    log(`── 验证${patch.ok && cordisOk && pluginVersion && visionConfigHasKey() ? '通过 ✓' : '未通过 ✗'}──`)
    process.exitCode = patch.ok && cordisOk && pluginVersion && visionConfigHasKey() ? 0 : 1
    return
  }

  log(`── ① 插件安装（源: ${args.pluginSource}）──`)
  const pluginStatus = installPlugin(args.profile, args.pluginSource).status

  log(`── ② 挂载 cordis 插件 ──`)
  mountCordis(args.profile)

  log(`── ③ 补丁 + 状态追踪 ──`)
  const { dshVersion, applied } = patchStep()

  const maintainExistingAgentsRules = agentsFileHasVisionPowerRules()
  if (args.writeAgents || maintainExistingAgentsRules) {
    log(args.writeAgents
      ? `── ④ 识图规则 → ~/.dsh/AGENTS.md（--write-agents）──`
      : `── ④ 检测到既有 VisionPower 规则，执行版本迁移 ──`)
    await writeAgentsRules()
  } else {
    log(`── ④ 识图规则：跳过（默认由插件在运行时注入；如需写入 ~/.dsh/AGENTS.md 请加 --write-agents）──`)
  }

  log(`── ⑤ VisionPower 配置控制台 ──`)
  await ensureConsole(args.profile, args.noConsole, args.waitSecs, args.forceConsole)

  log(`── ⑥ 验证 ──`)
  const pluginVersion = installedPluginVersion(profileDir(args.profile))
  const cordisOk = (() => {
    const file = path.join(profileDir(args.profile), 'cordis.patch.yml')
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('visionpower/dsh')
  })()
  log(`插件 visionpower@${pluginVersion ?? '?'} ${pluginVersion ? '✓' : '✗'}`)
  log(`cordis 挂载 ${cordisOk ? '✓' : '✗'}`)
  log(`补丁（dsh ${dshVersion ?? '?'}）✓（上一步已确认结构不匹配 0、语法失败 0）`)
  log(`VisionPower 配置 ${visionConfigHasKey() ? '✓ 已配置' : '✗ 未配置'}`)

  let launchResult = { status: 'skipped' }
  if (args.launch) {
    log(`── ⑦ 启动 dsh web ──`)
    launchResult = await launchDshWeb()
  } else {
    log(`── ⑦ 跳过启动 dsh web（加 --launch 可自动启动并打开浏览器）──`)
  }

  // 插件或补丁有更新时，运行中的 dsh web 不会热加载，必须重启才生效
  if ((pluginStatus !== 'skip' || applied > 0) && launchResult.status !== 'started') {
    warn('本次安装更新了插件/补丁，但检测到 dsh web 已在运行。请停止现有进程后重新运行本安装命令，使更新生效。')
  }

  log('完成。拖图/粘贴图片后，插件会在图片相关回合注入识图规则，describe_image 通过 dsh 附件服务直接读取当前图片；配置可在 Settings → Plugins → VisionPower 中修改。这条命令随时可重跑（幂等，已就位的步骤自动跳过）：dsh 升级/重装后重跑会自动重打补丁；在 dsh 里新增/更换纯文本模型不需要任何操作——补丁按模型无关方式放行图片消息，新模型自动被覆盖，重跑一遍可顺便验证链路完好。')
}

const directPath = fileURLToPath(import.meta.url)
const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : ''
// 经符号链接调用时（如 macOS 的 /tmp -> /private/tmp）两侧路径不相等，先做 realpath 归一化
const realPath = (p) => { try { return fs.realpathSync(p) } catch { return p } }
// Windows 路径大小写不敏感；大小写不同会误判为「非直接运行」
const isDirectRun = realPath(argv1) === realPath(directPath)
  || (IS_WIN && argv1.toLowerCase() === directPath.toLowerCase())
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`[setup-dsh] ✗ ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
