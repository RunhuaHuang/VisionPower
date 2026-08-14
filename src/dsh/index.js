// Native DeepSeek Harness (dsh) Cordis plugin for VisionPower, shipped as the
// `visionpower/dsh` subpath of the main `visionpower` package.
//
// Registers the first-class `describe_image` tool on the harness ToolRuntime,
// backed by the self-contained core bundle — the same canonical core the MCP
// server and the standalone Skill use. Credential/model resolution is shared:
// ~/.visionpower/config.json plus the VISIONPOWER_* / OPENAI_API_KEY
// environment variables, with this plugin's cordis.yml `config` applied last.
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

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describeImage, loadVisionConfig, resolveModelCapabilities } from './core.bundle.js'

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
}
