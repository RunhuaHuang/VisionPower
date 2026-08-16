// Native DeepSeek Harness (dsh) Cordis plugin for VisionPower, shipped as the
// `visionpower/dsh` subpath of the main `visionpower` package.
//
// Registers the first-class `describe_image` tool on the harness ToolRuntime,
// backed by the self-contained core bundle — the same canonical core the MCP
// server and the standalone Skill use. Credential/model resolution is shared:
// ~/.visionpower/config.json plus the VISIONPOWER_* / OPENAI_API_KEY
// environment variables, with this plugin's cordis.yml `config` applied last.
//
// describe_image stays a plain tool: the agent calls it during its normal
// tool-calling phase, with visible progress in the dsh UI and one vision call
// per image. Vision never blocks the start of a turn — an earlier design
// pre-described images in agent/pre-step, but dsh only materializes the turn's
// messages (including the user's own image) when step 1 starts, so the wait
// rendered as dead air with the sent image invisible.
//
// Beyond the tool, one zero-friction behaviour for text-only (non-multimodal)
// model routes: rules injection (config `injectRules`, default true) — on the
// first step of every turn the canonical image-locating rules (src/dsh/rules.js)
// are injected into the agent context via `agent/pre-step`, unless the same
// rules are already present (e.g. loaded from ~/.dsh/AGENTS.md). The rules tell
// the agent how to locate the content-addressed attachment files behind
// dragged/pasted images and to call describe_image on them.
//
// cordis.patch.yml row:
//
//   - insert:
//       - id: visionpower
//         name: 'visionpower/dsh'
//         config:            # all fields optional
//           model: MiniMax-M3
//           baseUrl: https://api.minimaxi.com/v1
//           protocol: openai    # or anthropic; inferred from model/baseUrl when omitted
//           timeoutMs: 60000
//           firstByteTimeoutMs: 15000
//           injectRules: true    # inject image-locating rules each turn (default true)

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeImage, loadVisionConfig, resolveModelCapabilities } from './core.bundle.js'
import { RULES_MARKER, RULES_TEXT } from './rules.js'

export const name = 'visionpower'

export const inject = ['tools']

// All fields optional: the core resolves the persistent config file and the
// environment on its own; these overrides apply on top for operators who
// prefer composition-level settings.
export const Config = z.object({
  model: z.string(),
  baseUrl: z.string(),
  protocol: z.string(),
  apiKeyEnv: z.string(),
  configPath: z.string(),
  timeoutMs: z.number(),
  firstByteTimeoutMs: z.number(),
  injectRules: z.boolean(),
  debug: z.boolean(),
}).default({})

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff']

const imageSourceParameters = {
  image_path: {
    type: 'string',
    description: 'Absolute path to a local raster image file. Use this when the image is available on disk.',
  },
  image_url: {
    type: 'string',
    description: 'Public http(s) URL of an image; support depends on the configured provider/model. Use image_base64 or image_ref when URL input is unavailable.',
  },
  image_base64: {
    type: 'string',
    description: 'Base64-encoded image data without a data: URI prefix.',
  },
  image_ref: {
    type: 'string',
    description: 'Short-lived opaque reference created by the VisionPower WebUI Inbox. Use this when a text-only host cannot pass an attachment through to the agent.',
  },
  image_mime_type: {
    type: 'string',
    enum: IMAGE_MIME_TYPES,
    description: 'MIME type for image_base64. If omitted, VisionPower detects it from image bytes.',
  },
}

// Merge composition-level plugin config over the core's own resolution
// (config file + environment). Plugin config wins for the keys it sets,
// because the operator wrote it explicitly in the profile composition.
function resolveConfig(overrides) {
  const env = overrides.configPath
    ? { ...process.env, VISIONPOWER_CONFIG: overrides.configPath }
    : process.env
  const base = loadVisionConfig(env)
  if (overrides.model !== undefined) base.model = overrides.model
  if (overrides.baseUrl !== undefined) base.baseUrl = overrides.baseUrl
  if (overrides.timeoutMs !== undefined) base.requestTimeoutMs = overrides.timeoutMs
  if (overrides.firstByteTimeoutMs !== undefined) base.firstByteTimeoutMs = overrides.firstByteTimeoutMs
  if (overrides.debug !== undefined) base.debug = overrides.debug
  if (overrides.apiKeyEnv) {
    const key = process.env[overrides.apiKeyEnv]
    if (key) base.apiKey = key
  }
  if (overrides.protocol !== undefined) {
    // An explicit operator choice wins over everything. Normalize like the
    // core's normalizeProtocol (which the bundle keeps private).
    const protocol = String(overrides.protocol).toLowerCase()
    if (!['openai', 'anthropic'].includes(protocol)) {
      throw new Error('visionpower plugin config "protocol" must be "openai" or "anthropic"')
    }
    base.protocol = protocol
  } else if (overrides.baseUrl !== undefined) {
    // The request shape must match the final endpoint, and the capability
    // registry infers the protocol from the hostname alone. Only a baseUrl
    // override can invalidate the resolved protocol — a model-only override
    // must keep it, so an explicit "protocol": "anthropic" in the config file
    // for a custom gateway survives a plugin model switch.
    base.protocol = resolveModelCapabilities(base.model, base.baseUrl).protocol
  }
  return base
}

function textOf(message) {
  const content = message?.content
  if (typeof message?.text === 'string') return message.text
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b?.type === 'text' ? b.text : '')).join('\n')
}

// 规则只在图片相关回合注入：消息带 image 块、用户文本提到图/截图/照片/screenshot、
// 或用户文本为空（纯图片消息在文本线路上就长这样）。纯文本回合不注入，避免每轮
// 一份 ~1.5KB 的规则在会话历史里线性累积。
function turnMentionsImages(messages) {
  for (const message of messages) {
    if (message?.source?.kind !== 'user') continue
    const content = message?.content
    if (Array.isArray(content) && content.some((b) => b?.type === 'image')) return true
    const text = textOf(message)
    if (!text.trim()) return true
    if (/图|图片|截图|照片|screenshot|image/i.test(text)) return true
  }
  return false
}

function rulesAlreadyPresent(messages) {
  for (const message of messages) {
    const text = textOf(message)
    if (text.includes(RULES_MARKER) || text.includes('定位与识图规则')) return true
  }
  return false
}

// 官方 workspace 指令装载（dsh-agent-instructions）在本插件**之后**才把
// ~/.dsh/AGENTS.md 注入 decision.messages（注册顺序：官方 bundle 先于 profile
// patch 层，waterfall 中外层先跑）——我们的组合时机看不到它，第一轮会重复注入。
// 因此直接读用户全局 AGENTS.md 判定：文件里已有规则就交给官方装载，插件不注入。
function userGlobalAgentsHasRules() {
  try {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const text = readFileSync(path.join(dshHome, 'AGENTS.md'), 'utf8')
    return text.includes(RULES_MARKER) || text.includes('定位与识图规则')
  } catch {
    return false
  }
}

// 异步运行一键安装器：绝不能 spawnSync——那会阻塞 dsh web 宿主的事件循环长达
// 数分钟，期间 UI 无响应且取消信号无法派发。收集 stdout/stderr，超时与取消都
// 先 kill 子进程、由 close 事件统一收尾（保留已产生的输出）。
function runInstaller(argv, signal) {
  const script = fileURLToPath(new URL('../../scripts/setup-dsh.mjs', import.meta.url))
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ out, ...payload })
    }
    const child = spawn(process.execPath, [script, ...argv], { cwd: os.homedir() })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ status: null, error: 'timeout after 300s' })
    }, 300000)
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('error', (error) => finish({ status: null, error: error instanceof Error ? error.message : String(error) }))
    child.on('close', (status) => finish({ status, error: null }))
    const onAbort = () => child.kill('SIGKILL')
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'describe_image',
    description: 'See and understand images — screenshots, photos, diagrams, charts. Extract text (OCR), describe scenes, compare images, and answer questions about what is shown. Use whenever an image is provided via image_path, image_url, image_base64, image_ref, or images[]. For faster, more useful answers, ask the specific question you need answered (e.g. "read the error text", "what does this chart show") instead of an open-ended "describe everything".',
    parameters: {
      ...imageSourceParameters,
      images: {
        type: 'array',
        items: {
          type: 'object',
          properties: imageSourceParameters,
          additionalProperties: false,
        },
        description: 'Ordered list of images to analyze. Use this for multiple images; do not combine it with top-level image fields.',
      },
      prompt: {
        type: 'string',
        description: 'Specific question or instruction about the image(s). Focused questions (e.g. "Read the error message text") are faster and more useful than open-ended "describe everything" prompts. Leave empty for a full description.',
      },
      output_format: {
        type: 'string',
        enum: ['text', 'structured'],
        description: "Output shape. 'text' (default) returns a free-form description with an untrusted-source banner. 'structured' returns a JSON envelope: when formatValid is true, a single image has {answer, observations, extractedText?, limitations?} and multiple images have images[]; otherwise formatValid is false with formatError and rawResponse.",
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      return describeImage(args, resolveConfig(config), exec.signal)
    },
  }))

  // ─────────────────────────────────────────────────────────────────────────
  // setup_visionpower: agent-facing entry into the idempotent installer.
  // After the plugin is installed, ANY user phrasing of "install / configure /
  // fix / check VisionPower" maps to this tool — far more reliable than hoping
  // the model re-derives the flow from a README. Runs scripts/setup-dsh.mjs in
  // a child process (isolates exit codes and captures its stdout/stderr), with
  // a short API-key wait: an unconfigured user is guided to the console and the
  // agent simply re-runs this tool after they finish.
  // ─────────────────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'setup_visionpower',
    description: 'Install, configure, or verify the VisionPower image-understanding plugin for dsh (drag-and-drop / paste image recognition). Run this whenever the user asks to install, set up, configure, repair, or check VisionPower (e.g. "配置一下 VisionPower", "拖图识图不好使了", "check the visionpower plugin"). Idempotent and safe to re-run: it chains plugin install, cordis mount, the image-accept patch (auto re-applied after dsh upgrades), the config console (http://127.0.0.1:17900), and verification, then returns a full report.',
    parameters: {
      profile: {
        type: 'string',
        description: 'Target dsh profile (default "web").',
      },
      launch: {
        type: 'boolean',
        description: 'Also launch dsh web and open the browser at the end (default false).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const argv = ['--wait-secs', '20']
      if (args?.profile) argv.push('--profile', String(args.profile))
      if (args?.launch) argv.push('--launch')
      const result = await runInstaller(argv, exec.signal)
      const out = result.out.trim()
      if (result.error) {
        return `[setup_visionpower] 安装器未能完成运行（${result.error}）。已有输出：\n${out}`
      }
      if (result.status === 0) {
        return `${out}\n\n[setup_visionpower] 成功。若上方显示 VisionPower 已配置（含 API key），全部就绪；若尚未配置，请引导用户在浏览器完成 http://127.0.0.1:17900 的 CONFIG 页配置（选视觉模型 + 粘贴 API Key + 保存），然后再次调用本工具验证。`
      }
      return `${out}\n\n[setup_visionpower] 未完全成功（退出码 ${result.status}）。请把上方关键输出转告用户；若是等待 API key 超时，引导用户在 http://127.0.0.1:17900 完成配置后重试本工具；其余报错按上方 ✗/⚠ 提示处理。`
    },
  }))

  // ─────────────────────────────────────────────────────────────────────────
  // pre-step: inject the locating rules on step 1 unless already present
  // (e.g. ~/.dsh/AGENTS.md workspace instructions). Vision itself never
  // happens here — describe_image is a plain tool the agent calls during
  // its normal tool-calling phase, with visible progress in the dsh UI.
  // ─────────────────────────────────────────────────────────────────────────
  ctx.on('agent/pre-step', async (input, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || input?.step !== 1) return decision

    // 组合失败绝不能破坏 agent 回合——出错时降级为原样返回 decision
    try {
      if (config.injectRules !== false
        && turnMentionsImages(decision.messages)
        && !rulesAlreadyPresent(decision.messages)
        && !userGlobalAgentsHasRules()) {
        const rules = createUserMessage({
          content: [{ type: 'text', text: RULES_TEXT }],
          source: { kind: 'plugin', plugin: 'visionpower' },
        })
        return { ...decision, messages: [...decision.messages, rules] }
      }
      return decision
    } catch (error) {
      ctx.logger?.warn?.('[visionpower] pre-step composition failed: %o', error)
      return decision
    }
  })
}
