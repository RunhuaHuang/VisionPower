#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadVisionConfig } from './config.js'
import { describeImage } from './vision-core.js'
import { toolInputSchemaShape } from './schema.js'

const server = new McpServer({
  name: 'visionpower',
  title: 'VisionPower',
  version: '1.3.0',
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
      // The MCP SDK has already validated `args` against the registered input
      // schema, so here we only enforce the cross-field rule that at least one
      // image source is present before reaching out to the provider.
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

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('VisionPower server error:', error)
  process.exit(1)
})
