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
    description: 'Analyze one or more images with an OpenAI-compatible vision model. Supports local image_path, image_url, image_base64, or ordered images[].',
    inputSchema: toolInputSchemaShape,
  },
  async (args) => {
    try {
      const params = args ?? {}
      if (!params.image_path && !params.image_url && !params.image_base64 && !params.images?.length) {
        const text = params.image_mime_type
          ? 'image_mime_type can only be used with image_base64.'
          : 'Provide one of image_path, image_url, image_base64, or images[].'
        return {
          content: [{ type: 'text', text }],
          isError: true,
        }
      }

      const config = loadVisionConfig()
      const text = await describeImage(params, config)
      return {
        content: [{ type: 'text', text }],
      }
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
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--version' || arg === '-v') parsed.version = true
    else if (arg === '--webui' || arg === 'webui') parsed.webui = true
    else if (arg === '--port') {
      const next = argv[i + 1]
      const port = Number(next)
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        parsed.port = port
        i++
      } else {
        process.stderr.write(
          `[visionpower] WARNING: Invalid --port value "${next}", using default ${parsed.port}\n`
        )
        if (next && !next.startsWith('-')) i++ // consume the bad value to avoid misparse
      }
    }
  }
  return parsed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

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
