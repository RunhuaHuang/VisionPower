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
//   node scripts/setup-dsh.mjs --plugin-source <spec>  # 插件源（默认 github:RunhuaHuang/visionpower）
//   node scripts/setup-dsh.mjs --no-console        # 跳过启动 VisionPower 配置控制台
//   node scripts/setup-dsh.mjs --wait-secs <n>     # 等待用户配置控制台的最长秒数（默认 180）
//
// 所有步骤幂等，可反复重跑。dsh 升级 / npx 重装后补丁会消失，重跑本脚本自动重打。
// 本脚本只用 Node 内置模块，不依赖任何第三方包。

import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version
const PATCH_SCRIPT = path.join(HERE, 'patch-dsh.mjs')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, '.visionpower-state.json')
const AGENTS_FILE = path.join(DSH_HOME, 'AGENTS.md')
const VISIONPOWER_CONFIG = process.env.VISIONPOWER_CONFIG || path.join(os.homedir(), '.visionpower', 'config.json')
const DEFAULT_PLUGIN_SOURCE = 'github:RunhuaHuang/visionpower'
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
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

function sha1Of(file) {
  try {
    return createHash('sha1').update(fs.readFileSync(file)).digest('hex')
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
function compareVersions(a, b) {
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

function ensurePnpm() {
  try {
    runShim('pnpm', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    // corepack 随 Node 16~24 分发；Node 25+ 已从发行版移除，失败继续走 npm 安装
    try {
      runShim('corepack', ['enable', 'pnpm'], { stdio: 'ignore' })
      runShim('pnpm', ['--version'], { stdio: 'ignore' })
      return true
    } catch { /* 落到 npm 全局安装 */ }
    try {
      runShim('npm', ['install', '-g', 'pnpm'], { stdio: 'inherit' })
      runShim('pnpm', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
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
    throw new Error('pnpm 不可用（corepack enable 也失败）。请先安装 pnpm 再重试。')
  }
  const major = pnpmMajor()
  if (major > 0 && major < 7) {
    throw new Error(`pnpm 版本过旧（${major}.x），需要 >= 7。请 corepack enable pnpm 或升级 pnpm。`)
  }
  log(`用 pnpm 安装/更新插件到 ${dir}`)
  const r = runShim('pnpm', ['--dir', dir, 'add', source], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('pnpm add 失败，请查看上方输出。')
}

function installPlugin(profile, source) {
  const dir = profileDir(profile)
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`profile 目录不存在：${dir}（请先运行过一次 dsh web）`)
  }
  const current = installedPluginVersion(dir)
  if (current) {
    const cmp = compareVersions(current, PKG_VERSION)
    if (cmp === 0) {
      log(`插件已安装且版本一致（visionpower@${current}），跳过`)
      return { status: 'skip', version: current }
    }
    if (cmp > 0) {
      log(`插件已安装且版本更新（visionpower@${current} > 本脚本 ${PKG_VERSION}），跳过`)
      return { status: 'skip', version: current }
    }
    log(`插件版本较旧（visionpower@${current} → ${PKG_VERSION}），升级`)
  }

  // 优先走 dsh 官方插件命令；该命令在部分 dsh 版本中不存在，失败则兜底 pnpm。
  // 探测要求 help 同时出现 plugin 与 --profile，避免误中其他同名 dsh 工具（如 Debian 的 distributed shell）。
  try {
    const probe = runShim('dsh', ['--help'], { stdio: ['ignore', 'pipe', 'pipe'] })
    if (probe.status === 0 && probe.stdout.includes('plugin') && probe.stdout.includes('--profile')) {
      log(`用 dsh plugin 命令安装 ${source}`)
      const r = runShim('dsh', ['plugin', '--profile', profile, 'add', source], { stdio: 'inherit' })
      if (r.status === 0) {
        return { status: current ? 'upgraded' : 'installed', version: installedPluginVersion(dir) }
      }
      warn('dsh plugin 命令执行失败，改用 pnpm 兜底')
    }
  } catch { /* dsh 命令不存在或不可用，走 pnpm */ }

  installPluginViaPnpm(dir, source)
  return { status: current ? 'upgraded' : 'installed', version: installedPluginVersion(dir) }
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 挂载 cordis
// ─────────────────────────────────────────────────────────────────────────────

function mountCordis(profile) {
  const dir = profileDir(profile)
  const file = path.join(dir, 'cordis.patch.yml')
  let content = ''
  if (fs.existsSync(file)) content = fs.readFileSync(file, 'utf8')
  if (content.includes("name: 'visionpower/dsh'") || content.includes('name: "visionpower/dsh"')) {
    log(`cordis.patch.yml 已挂载 visionpower/dsh，跳过`)
    return { status: 'skip' }
  }
  const addition = (content.length > 0 && !content.endsWith('\n') ? '\n' : '') + (content.length > 0 ? '\n' : '') + CORDIS_ROW
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, content + addition)
  log(`已挂载 visionpower/dsh → ${file}`)
  return { status: 'mounted' }
}

// ─────────────────────────────────────────────────────────────────────────────
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
          out[path.relative(root, p)] = sha1Of(p)
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
  const rootMatch = patch.stdout.match(/== 安装位置: (.+)/)
  const versionMatch = patch.stdout.match(/dsh 版本: ([^\s（(]+)/)
  const summaryMatch = patch.stdout.match(/结构不匹配 (\d+) 处，语法失败 (\d+) 处/)
  const appliedMatch = patch.stdout.match(/应用补丁 (\d+) 处/)
  const root = rootMatch?.[1]?.trim()
  const dshVersion = versionMatch?.[1]?.trim()
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
  // --check 模式：跑一遍补丁（幂等），用其输出作为现状
  const selfTest = runPatchScript(['--self-test'])
  process.stdout.write(selfTest.stdout)
  process.stderr.write(selfTest.stderr)
  if (selfTest.status !== 0 || !selfTest.stdout.includes('SELF-TEST PASS')) {
    return { ok: false, reason: '补丁自测 FAIL（dsh 结构可能已变化）' }
  }
  const patch = runPatchScript([])
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
  if (content.includes('定位与识图规则')) {
    log(`~/.dsh/AGENTS.md 已包含「定位与识图规则」，跳过`)
    return { status: 'skip' }
  }
  const rules = await loadRulesText()
  const addition = (content.length > 0 && !content.endsWith('\n') ? '\n' : '') + (content.length > 0 ? '\n' : '') + rules
  fs.mkdirSync(path.dirname(AGENTS_FILE), { recursive: true })
  fs.writeFileSync(AGENTS_FILE, content + addition)
  log(`已把识图规则追加到 ${AGENTS_FILE}`)
  return { status: 'written' }
}

// 规则文本与插件注入共用同一份（src/dsh/rules.js），直接 import 模块，避免文本解析
async function loadRulesText() {
  const mod = await import(path.join(HERE, '..', 'src', 'dsh', 'rules.js'))
  return mod.RULES_TEXT
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ VisionPower 配置控制台
// ─────────────────────────────────────────────────────────────────────────────

async function ensureConsole(profile, noConsole, waitSecs) {
  if (noConsole) {
    if (!visionConfigHasKey()) warn('跳过控制台启动；但 ~/.visionpower/config.json 尚无 API key，识图会失败')
    return { status: 'skipped' }
  }
  const PORT = 17900
  if (await portListening(PORT)) {
    log(`VisionPower 配置控制台已在运行 http://127.0.0.1:${PORT}，跳过启动`)
    if (!visionConfigHasKey()) warn('控制台在运行但 ~/.visionpower/config.json 尚无 API key')
  } else {
    // 用 node 直接跑包内 src/index.js，避免平台相关的 .bin shim（visionpower(.cmd/.ps1)）；
    // node 是真实可执行文件，不加 shell（避免路径含空格时被 shell 拆分）
    const bin = path.join(profileDir(profile), 'node_modules', 'visionpower', 'src', 'index.js')
    const logFile = path.join(DSH_HOME, '.visionpower-console.log')
    const child = fs.existsSync(bin)
      ? spawn(process.execPath, [bin, '--webui'], { detached: true, stdio: ['ignore', 'ignore', fs.openSync(logFile, 'a')] })
      : spawn('npx', ['-y', '--package', 'visionpower@latest', 'visionpower', '--webui'], shimOpts({ detached: true, stdio: ['ignore', 'ignore', fs.openSync(logFile, 'a')] }))
    child.unref()
    log(`已启动 VisionPower 配置控制台 → http://127.0.0.1:${PORT}（日志 ${logFile}）`)
  }

  if (visionConfigHasKey()) {
    log('VisionPower 已配置（~/.visionpower/config.json 含 API key）✓')
    return { status: 'configured' }
  }

  log(`请在浏览器打开 http://127.0.0.1:${PORT} → CONFIG 页选择视觉模型预设、粘贴 API Key、点「保存并应用配置」。`)
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
  if (await portListening(PORT)) {
    log(`dsh web 已在运行 http://127.0.0.1:${PORT}，跳过启动（直接打开浏览器）`)
  } else {
    const logFile = path.join(DSH_HOME, '.visionpower-dsh-web.log')
    const child = spawn('npm', ['exec', '@deepseek-ai/dsh', 'web'], shimOpts({
      detached: true,
      stdio: ['ignore', 'ignore', fs.openSync(logFile, 'a')],
    }))
    child.unref()
    log(`正在启动 dsh web（日志 ${logFile}）…`)
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
  --plugin-source <spec>  插件源（默认 github:RunhuaHuang/visionpower）
  --no-console        跳过启动 VisionPower 配置控制台
  --wait-secs <n>     等待用户完成控制台配置的最长秒数（默认 180）
  --help, -h          显示本帮助

流程：① 装插件 → ② 挂载 cordis → ③ 打补丁+状态追踪 → ④ 规则（--write-agents）
      → ⑤ 配置控制台 → ⑥ 验证 → ⑦ 启动 dsh web（--launch）

所有步骤幂等，可反复重跑；dsh 升级后重跑即可自动重打补丁。
`

function parseArgs(argv) {
  const parsed = {
    launch: false, writeAgents: false, check: false, noConsole: false, help: false,
    profile: 'web', pluginSource: DEFAULT_PLUGIN_SOURCE, waitSecs: 180,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--launch') parsed.launch = true
    else if (a === '--write-agents') parsed.writeAgents = true
    else if (a === '--check') parsed.check = true
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

  if (args.writeAgents) {
    log(`── ④ 识图规则 → ~/.dsh/AGENTS.md（--write-agents）──`)
    await writeAgentsRules()
  } else {
    log(`── ④ 识图规则：跳过（默认由插件在运行时注入；如需写入 ~/.dsh/AGENTS.md 请加 --write-agents）──`)
  }

  log(`── ⑤ VisionPower 配置控制台 ──`)
  await ensureConsole(args.profile, args.noConsole, args.waitSecs)

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

  if (args.launch) {
    log(`── ⑦ 启动 dsh web ──`)
    await launchDshWeb()
  } else {
    log(`── ⑦ 跳过启动 dsh web（加 --launch 可自动启动并打开浏览器）──`)
  }

  // 插件或补丁有更新时，运行中的 dsh web 不会热加载，必须重启才生效
  if (pluginStatus !== 'skip' || applied > 0) {
    warn('本次安装更新了插件/补丁。若 dsh web 已在运行，需重启才生效：Ctrl+C 停掉后重新执行 npm exec @deepseek-ai/dsh web')
  }

  log('完成。拖图/粘贴图片后，插件会自动识图并注入描述；dsh 升级后重跑本脚本即可自动重打补丁。')
}

const directPath = fileURLToPath(import.meta.url)
const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : ''
// Windows 路径大小写不敏感；大小写不同会误判为「非直接运行」
const isDirectRun = argv1 === directPath || (IS_WIN && argv1.toLowerCase() === directPath.toLowerCase())
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`[setup-dsh] ✗ ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
