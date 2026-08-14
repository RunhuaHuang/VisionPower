#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createRequire } from 'node:module'
import { loadVisionConfig, getConfigFilePath } from './config.js'
import { describeImage } from './vision-core.js'
import { toolInputSchemaShape } from './schema.js'
import { startWebuiServer } from './webui/server.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

const HELP = `
VisionPower — Portable Image Understanding MCP Server

Usage:
  visionpower                       Run in stdio MCP mode (default, for Claude/Cursor/Cline)
  visionpower --webui               Start local WebUI configuration and testing console
  visionpower --webui --port <port> Specify WebUI port (default 17900)
  visionpower --version             Show version number
  visionpower --help                Show this help message

Configuration file:
  ~/.visionpower/config.json (Override with VISIONPOWER_CONFIG env var)
`.trim()

const server = new McpServer({
  name: 'visionpower',
  title: 'VisionPower',
  version,
})

server.registerTool(
  'describe_image',
  {
    title: 'Describe Image',
      description: 'See and understand images — screenshots, photos, diagrams, charts. Extract text (OCR), describe scenes, compare images, and answer questions about what is shown. Use whenever an image is provided via image_path, image_url, image_base64, image_ref, or images[]. For faster, more useful answers, ask the specific question you need answered (e.g. "read the error text", "what does this chart show") instead of an open-ended "describe everything".',
      inputSchema: toolInputSchemaShape,
      annotations: {
        openWorldHint: true,
      },
  },
  async (args) => {
    try {
      const params = args ?? {}
      if (!params.image_path && !params.image_url && !params.image_base64 && !params.image_ref && !params.images?.length) {
        const text = params.image_mime_type
          ? 'image_mime_type can only be used with image_base64.'
          : 'Provide one of image_path, image_url, image_base64, image_ref, or images[].'
        return {
          content: [{ type: 'text', text }],
          isError: true,
        }
      }

      const config = loadVisionConfig()
      const text = await describeImage(params, config)
      const result = {
        content: [{ type: 'text', text }],
      }
      // Keep the text payload for backward compatibility while also exposing
      // native MCP structuredContent to clients that can consume it.
      if (params.output_format === 'structured') {
        result.structuredContent = JSON.parse(text)
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `VisionPower failed: ${message}` }],
        isError: true,
      }
    }
  },
)

function parseArgs(argv) {
  const parsed = { webui: false, port: 17900, help: false, version: false }
  const seen = new Set()
  let portProvided = false
  const markSeen = (key, display) => {
    if (seen.has(key)) throw new Error(`Duplicate option: ${display}`)
    seen.add(key)
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      markSeen('help', '--help')
      parsed.help = true
    } else if (arg === '--version' || arg === '-v') {
      markSeen('version', '--version')
      parsed.version = true
    } else if (arg === '--webui' || arg === 'webui') {
      markSeen('webui', '--webui')
      parsed.webui = true
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      markSeen('port', '--port')
      portProvided = true
      const inline = arg.startsWith('--port=') ? arg.slice('--port='.length) : null
      const next = inline ?? argv[i + 1]
      if (inline === null) i += 1
      const port = Number(next)
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
        throw new Error(`Invalid --port value "${next ?? ''}"; expected an integer from 1 to 65535`)
      }
      parsed.port = port
    } else {
      throw new Error(`Unknown option or command: ${arg}`)
    }
  }
  if (portProvided && !parsed.webui && !parsed.help && !parsed.version) {
    throw new Error('--port can only be used with --webui')
  }
  return parsed
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`[visionpower] ${error.message}\n`)
    process.exitCode = 1
    return
  }

  if (args.help) {
    console.log(HELP)
    return
  }

  if (args.version) {
    console.log(version)
    return
  }

  if (args.webui) {
    await startWebuiServer(args.port)
    return
  }

  const config = loadVisionConfig()
  if (!config.apiKey) {
    process.stderr.write(
      `[visionpower] WARNING: No API key is configured. Model calls will fail.\n` +
      `[visionpower] Please run this server with \`--webui\` to complete configuration.\n` +
      `[visionpower] Config file: ${getConfigFilePath()}\n\n`
    )
  } else {
    process.stderr.write(
      `[visionpower] Connected in stdio mode. Model: ${config.model}\n` +
      `[visionpower] Config file: ${getConfigFilePath()}\n\n`
    )
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('VisionPower server error:', error)
  process.exit(1)
})
