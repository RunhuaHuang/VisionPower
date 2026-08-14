import * as z from 'zod/v4'

// Shared input schema for the describe_image capability. Both front-ends use it:
// the MCP server (src/index.js) registers `toolInputSchemaShape`, and tests use
// `toolInputSchema` to keep the Zod object form available for future front-ends.

export const imageSourceSchemaShape = {
  image_path: z.string().trim().min(1).optional().describe('Absolute path to a local raster image file. Use this when the image is available on disk.'),
  image_url: z.string().trim().min(1).optional().describe('Public http(s) URL of an image; support depends on the configured provider/model. Use image_base64 or image_ref when URL input is unavailable.'),
  image_base64: z.string().trim().min(1).optional().describe('Base64-encoded image data without a data: URI prefix.'),
  image_ref: z.string().trim().regex(/^vpimg_[A-Za-z0-9_-]{32}$/).optional().describe('Short-lived opaque reference created by the VisionPower WebUI Inbox. Use this when a text-only host cannot pass an attachment through to the agent.'),
  image_mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff']).optional().describe('MIME type for image_base64. If omitted, VisionPower detects it from image bytes.'),
}

export const imageSourceSchema = z.object(imageSourceSchemaShape).strict()

export const toolInputSchemaShape = {
  ...imageSourceSchemaShape,
  images: z.array(imageSourceSchema).min(1).optional().describe('Ordered list of images to analyze. Use this for multiple images; do not combine it with top-level image fields.'),
  prompt: z.string().trim().min(1).max(20_000).optional().describe('Specific question or instruction about the image(s). Focused questions (e.g. "Read the error message text", "List the visible menu items") are faster and more useful than open-ended "describe everything" prompts. Leave empty for a full description.'),
  output_format: z.enum(['text', 'structured']).optional().describe("Output shape. 'text' (default) returns a free-form description with an untrusted-source banner. 'structured' returns a JSON envelope: when formatValid is true, a single image has {answer, observations, extractedText?, limitations?} and multiple images have images[]; otherwise formatValid is false with formatError and rawResponse."),
}

export const toolInputSchema = z.object(toolInputSchemaShape).strict()
