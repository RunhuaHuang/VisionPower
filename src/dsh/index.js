// Native DeepSeek Harness (dsh) Cordis plugin for VisionPower, shipped as the
// `visionpower/dsh` subpath of the main `visionpower` package.
//
// Registers the first-class `describe_image` tool on the harness ToolRuntime,
// backed by the self-contained core bundle — the same canonical core the MCP
// server and the standalone Skill use. Credential/model resolution is shared:
// ~/.visionpower/config.json plus the VISIONPOWER_* / OPENAI_API_KEY
// environment variables, with this plugin's cordis.yml `config` applied last.
//
// Beyond the tool, the plugin wires two zero-friction behaviours for text-only
// (non-multimodal) model routes:
//
//  1. Rules injection (config `injectRules`, default true): on the first step
//     of every turn the canonical image-locating rules (src/dsh/rules.js) are
//     injected into the agent context via `agent/pre-step`, unless the same
//     rules are already present (e.g. loaded from ~/.dsh/AGENTS.md).
//
//  2. Auto-describe (config `autoDescribe`, default true): when a user message
//     carries image blocks, the plugin reads the attachment bytes via the
//     `attachments` service, runs the vision core, and injects the description
//     into the next `agent/pre-step` — the user never has to mention the image
//     or ask the agent to find it.
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
//           autoDescribe: true   # auto-recognize dragged/pasted images (default true)
//           injectRules: true    # inject image-locating rules each turn (default true)

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeImage, loadVisionConfig, resolveModelCapabilities } from './core.bundle.js'
import { RULES_MARKER, RULES_TEXT } from './rules.js'

export const name = 'visionpower'

export const inject = ['tools', 'attachments']

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
  autoDescribe: z.boolean(),
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

function imageBlocksOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return []
  return content.filter((b) => b?.type === 'image' && b?.attachment?.attachmentId)
}

function textOf(message) {
  const content = message?.content
  if (typeof message?.text === 'string') return message.text
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b?.type === 'text' ? b.text : '')).join('\n')
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

const AUTO_DESCRIBE_PROMPT =
  '请详细描述这张图片的内容：它是什么（截图/照片/图表/文档/界面等），包含哪些文字或关键信息？请尽量完整转录图中文字。'

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
  // Auto-describe: user message carries image blocks → read attachment bytes
  // → run the vision core → stage the description for the next pre-step.
  // ─────────────────────────────────────────────────────────────────────────
  const pendingDescriptions = new Map() // sessionId -> Promise<string>
  const seenImageDigests = new Map() // sessionId -> Set<digest>（按会话去重，跨会话不误判）

  async function describeAttachmentImages(blocks, overrides, signal) {
    const resolved = []
    for (const block of blocks) {
      const stored = await ctx.attachments.readImage(block.attachment, signal)
      resolved.push({
        image_base64: Buffer.from(stored.data).toString('base64'),
        image_mime_type: block.attachment.mediaType,
      })
    }
    const params = resolved.length === 1
      ? { ...resolved[0], prompt: AUTO_DESCRIBE_PROMPT }
      : { images: resolved, prompt: AUTO_DESCRIBE_PROMPT }
    return describeImage(params, resolveConfig(overrides), signal)
  }

  if (config.autoDescribe !== false) {
    ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'user/message') return
        const blocks = imageBlocksOf(event.data)
        if (blocks.length === 0) return
        const digest = blocks.map((b) => b.attachment.attachmentId).join('|')
        const sessionKey = session?.id ?? 'default'
        // 会话键上限：长驻进程下防止旧会话的 Set 无限累积
        if (seenImageDigests.size >= 32 && !seenImageDigests.has(sessionKey)) {
          const oldestKey = seenImageDigests.keys().next().value
          seenImageDigests.delete(oldestKey)
        }
        let seen = seenImageDigests.get(sessionKey)
        if (!seen) {
          seen = new Set()
          seenImageDigests.set(sessionKey, seen)
        }
        if (seen.has(digest)) return
        if (seen.size > 64) {
          const oldest = seen.values().next().value
          seen.delete(oldest)
        }
        seen.add(digest)
        const controller = new AbortController()
        const task = describeAttachmentImages(blocks, config, controller.signal)
          .then((text) => ({ text }))
          .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
        // 同会话已有未消费的识图任务（连发多图）→ 中止旧的，只保留最新
        const previous = pendingDescriptions.get(sessionKey)
        if (previous) previous.controller.abort()
        if (pendingDescriptions.size >= 32 && !pendingDescriptions.has(sessionKey)) {
          const oldestKey = pendingDescriptions.keys().next().value
          const stale = pendingDescriptions.get(oldestKey)
          if (stale) stale.controller.abort()
          pendingDescriptions.delete(oldestKey)
        }
        pendingDescriptions.set(sessionKey, { task, controller })
      } catch (error) {
        ctx.logger?.warn?.('[visionpower] auto-describe hook failed: %o', error)
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // pre-step: inject staged auto-descriptions, then the locating rules unless
  // already present (e.g. ~/.dsh/AGENTS.md workspace instructions).
  // ─────────────────────────────────────────────────────────────────────────
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || step !== 1) return decision

    // 组合失败绝不能破坏 agent 回合——出错时降级为原样返回 decision
    try {
      const additions = []
      const pending = pendingDescriptions.get(agent?.sessionId ?? 'default')
      if (pending) {
        pendingDescriptions.delete(agent?.sessionId ?? 'default')
        try {
          // Cap the wait so a slow vision provider cannot stall the agent turn;
          // on abort/timeout the rules fallback still lets the agent find the
          // image on its own.
          const capMs = Math.max(Number(config.timeoutMs) || 0, 60000) + 5000
          let timer
          const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), capMs) })
          // 若 signal 已中止，监听器永远不会触发——必须先判 aborted
          const aborted = signal.aborted
            ? Promise.resolve({ aborted: true })
            : new Promise((resolve) => signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true }))
          let result
          try {
            result = await Promise.race([pending.task, timeout, aborted])
          } finally {
            clearTimeout(timer)
          }
          if (result?.text) {
            additions.push(createUserMessage({
              content: [{ type: 'text', text: `[VisionPower 自动识图] 用户消息附带图片，自动识图结果：\n${result.text}` }],
              source: { kind: 'plugin', plugin: 'visionpower' },
            }))
          } else if (result?.error) {
            additions.push(createUserMessage({
              content: [{ type: 'text', text: `[VisionPower 自动识图] 用户消息附带图片，但自动识图失败：${result.error}。需要时请按规则手动调用 describe_image 定位并识别。` }],
              source: { kind: 'plugin', plugin: 'visionpower' },
            }))
          } else if (result?.timeout) {
            additions.push(createUserMessage({
              content: [{ type: 'text', text: `[VisionPower 自动识图] 图片描述生成超时（>${Math.round(capMs / 1000)}s），需要时请按规则手动调用 describe_image 定位并识别。` }],
              source: { kind: 'plugin', plugin: 'visionpower' },
            }))
          }
          // result.aborted → 回合已被取消，不注入任何内容
        } catch (error) {
          ctx.logger?.warn?.('[visionpower] auto-describe injection failed: %o', error)
        } finally {
          pending.controller.abort()
        }
      }

      if (config.injectRules !== false && !rulesAlreadyPresent(decision.messages) && !userGlobalAgentsHasRules()) {
        additions.push(createUserMessage({
          content: [{ type: 'text', text: RULES_TEXT }],
          source: { kind: 'plugin', plugin: 'visionpower' },
        }))
      }

      if (additions.length === 0) return decision
      return { ...decision, messages: [...decision.messages, ...additions] }
    } catch (error) {
      ctx.logger?.warn?.('[visionpower] pre-step composition failed: %o', error)
      return decision
    }
  })
}
