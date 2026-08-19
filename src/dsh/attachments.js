// DeepSeek Harness rc.7 image attachments are durable, opaque references.
// Keep this bridge free of dsh imports so it can be tested without installing
// optional peer dependencies into VisionPower's own node_modules.

const TOP_LEVEL_IMAGE_KEYS = ['image_path', 'image_url', 'image_base64', 'image_ref']

export function hasExplicitImageInput(args) {
  if (!args || typeof args !== 'object') return false
  if (TOP_LEVEL_IMAGE_KEYS.some((key) => typeof args[key] === 'string' && args[key].length > 0)) return true
  return Array.isArray(args.images) && args.images.length > 0
}

export function latestUserImageRefs(messages) {
  // Current turn only: the most recent user message, skipping any follow-up
  // plugin/assistant/tool messages. Images from earlier turns are NEVER picked
  // up implicitly — silent reuse of a previous image would mislead the user;
  // explicit attachment_scope='latest_in_session' opts into that behavior.
  if (!Array.isArray(messages)) return []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.source?.kind !== 'user' || !Array.isArray(message.content)) continue
    return message.content
      .filter((block) => block?.type === 'image' && block.attachment)
      .map((block) => block.attachment)
  }
  return []
}

export function sessionUserImageRefs(messages) {
  // Explicit reuse scope: scan the whole session for the newest user message
  // that carries images (used when the caller asks for latest_in_session).
  if (!Array.isArray(messages)) return []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.source?.kind !== 'user' || !Array.isArray(message.content)) continue
    const refs = message.content
      .filter((block) => block?.type === 'image' && block.attachment)
      .map((block) => block.attachment)
    if (refs.length > 0) return refs
  }
  return []
}

function disabledError() {
  const error = new Error('VisionPower is disabled in dsh. Turn it on in Settings → Plugins → VisionPower.')
  error.code = 'VISIONPOWER_DISABLED'
  return error
}

export async function withDshImageAttachments(args, exec, attachments, config = {}) {
  // The dsh-only switch is checked before deriving or reading any attachment.
  // Explicit image inputs still pass through untouched when enabled and are
  // validated by the canonical core below.
  if (config.dshEnabled === false) throw disabledError()
  // attachment_scope is dsh-only routing metadata: strip it on every return
  // path so the canonical core's unknown-field validation never sees it.
  const { attachment_scope: scopeArg, ...coreArgs } = args ?? {}
  if (hasExplicitImageInput(coreArgs)) return coreArgs

  // Default to the current turn. Reusing a previously sent image requires the
  // explicit attachment_scope='latest_in_session' so the user is never silently
  // billed against (or misled by) an old image.
  const scope = scopeArg === 'latest_in_session' ? 'latest_in_session' : 'current_turn'
  const messages = exec?.agent?.session?.deriveMessages?.()
  const refs = scope === 'latest_in_session'
    ? sessionUserImageRefs(messages)
    : latestUserImageRefs(messages)
  if (refs.length === 0) {
    if (scope === 'latest_in_session') {
      throw new Error('No image attachment exists in the dsh session history')
    }
    throw new Error('No image in the current message. If the image was sent in an earlier message, call again with attachment_scope="latest_in_session".')
  }
  if (!attachments || typeof attachments.readImage !== 'function') {
    throw new Error('dsh durable attachment service is unavailable; cannot read the current image attachment')
  }
  if (Number.isSafeInteger(config.maxImages) && refs.length > config.maxImages) {
    throw new Error(`Too many images; max is ${config.maxImages}`)
  }

  // rc.7 attachment references carry their byte length. Use it as an early
  // rejection hint so a request that is already known to exceed a configured
  // limit performs zero storage reads; actual bytes are still checked below in
  // case an older host omits the metadata or a provider returns stale data.
  let declaredTotalBytes = 0
  for (const ref of refs) {
    if (!Number.isSafeInteger(ref?.bytes) || ref.bytes < 0) continue
    if (Number.isSafeInteger(config.maxImageBytes) && ref.bytes > config.maxImageBytes) {
      throw new Error(`dsh attachment is too large; max is ${Math.round(config.maxImageBytes / 1024 / 1024)}MB`)
    }
    declaredTotalBytes += ref.bytes
    if (Number.isSafeInteger(config.maxTotalImageBytes) && declaredTotalBytes > config.maxTotalImageBytes) {
      throw new Error(`Total local/Base64 image data is too large; max is ${Math.round(config.maxTotalImageBytes / 1024 / 1024)}MB`)
    }
  }

  const storedImages = []
  let totalBytes = 0
  for (const ref of refs) {
    const stored = await attachments.readImage(ref, exec?.signal)
    const data = Buffer.isBuffer(stored.data)
      ? stored.data
      : (ArrayBuffer.isView(stored.data)
          ? Buffer.from(stored.data.buffer, stored.data.byteOffset, stored.data.byteLength)
          : Buffer.from(stored.data))
    if (Number.isSafeInteger(config.maxImageBytes) && data.length > config.maxImageBytes) {
      throw new Error(`dsh attachment is too large; max is ${Math.round(config.maxImageBytes / 1024 / 1024)}MB`)
    }
    totalBytes += data.length
    if (Number.isSafeInteger(config.maxTotalImageBytes) && totalBytes > config.maxTotalImageBytes) {
      throw new Error(`Total local/Base64 image data is too large; max is ${Math.round(config.maxTotalImageBytes / 1024 / 1024)}MB`)
    }
    storedImages.push({ data, mimeType: stored.ref.mediaType })
  }
  // Only allocate Base64 copies after the complete request has passed every
  // count and byte limit. A later oversized attachment therefore cannot leave
  // earlier images encoded unnecessarily.
  return {
    ...coreArgs,
    images: storedImages.map(({ data, mimeType }) => ({
      image_base64: data.toString('base64'),
      image_mime_type: mimeType,
    })),
  }
}
