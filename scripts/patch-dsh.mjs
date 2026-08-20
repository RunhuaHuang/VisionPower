#!/usr/bin/env node
// patch-dsh.mjs —— DSH「拖图不拒绝」跨平台补丁脚本（Windows / macOS / Linux）
//
// 用途：DSH 升级 / npx 重装后，官方源码自带的「图片拒绝」逻辑会回来。
//       更新后运行一次本脚本，自动重打全部补丁（幂等，可重复运行）。
//
// 版本适配：补丁按代码形状自动匹配（锚点只命中对应版本的源码结构），
//       覆盖 dsh 0.1.0-rc.6 / rc.7 / rc.8；主流程会报告识别出的版本与
//       启用的补丁集。rc.8 新增：deepseek stream() 入口拒绝、pi-ai
//       toPiContext 的 maxRequestImageBytes 参数变体。
//
// 用法：
//   node patch-dsh.mjs                  # 自动发现 DSH 安装位置并打补丁
//   node patch-dsh.mjs --dry-run        # 只探测与统计，不写入任何文件
//   node patch-dsh.mjs <node_modules根>  # 手动指定包含 @deepseek-ai 的目录
//   node patch-dsh.mjs --self-test      # 用原始代码片段自测补丁正则在
//                                        # 新版本结构下是否仍然匹配
//
// 打完补丁后记得重启：npm exec @deepseek-ai/dsh web
// 本脚本只用 Node 内置模块，不依赖任何第三方包。

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const T = (n) => '\t'.repeat(n);

function patchedPiStream(replayBlock = '', extraArg = '') {
  const lines = [
    "const containsImage = options.messages.some((message) => contentHasImage(message.content));",
    'const supportsImage = model.input.includes("image");',
    "const messages = containsImage && !supportsImage",
    "? options.messages.map((message) => ({ ...message, content: withoutImages(message.content) }))",
    ": options.messages;",
    "const attachments = containsImage && supportsImage ? this.config.resolveAttachments?.() : void 0;",
    'if (containsImage && supportsImage && attachments === void 0) throw new LlmError("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT");',
  ].map((line, i) => (i === 0 ? '' : i === 3 || i === 4 ? T(5) : T(4)) + line)
  // 首行不带缩进：正则匹配从原行缩进之后开始，原缩进会保留在替换文本之前，
  // 首行再带一层缩进就会叠成双倍（rc.7 时代的历史瑕疵，这里一并修正）。
  if (replayBlock) lines.push(replayBlock)
  // extraArg：rc.8 起 toPiContext 带图分支多出第 4 个参数（profile.maxRequestImageBytes），
  // 原样透传，保持与所在 dsh 版本的调用签名一致。
  lines.push(T(4) + (replayBlock
    ? `const context = attachments === void 0 ? toPiContext({ ...options, messages }, void 0, onReplayDegrade) : await toPiContext({ ...options, messages }, attachments, onReplayDegrade${extraArg});`
    : `const context = attachments === void 0 ? toPiContext({ ...options, messages }) : await toPiContext({ ...options, messages }, attachments${extraArg});`))
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// 补丁定义：每个补丁针对一个包内的 .js 文件。
//   already(source)  已打过补丁的判据（幂等跳过）
//   anchor(source)   旧代码存在的判据（存在才尝试替换）
//   apply(source)    正则替换；版本结构变化时可能替换不成功
// ─────────────────────────────────────────────────────────────────────────────

const patches = [
  {
    id: 'apiproxy: prompt 提交处理器图片拒绝',
    pkg: 'dsh-host-apiproxy',
    already: (s) => /Image content is admitted regardless of the selected model/.test(s),
    anchor: (s) => /MODEL_DOES_NOT_SUPPORT_IMAGES/.test(s) && /if \(hasImage\) \{/.test(s),
    apply: (s) => s.replace(
      /if \(hasImage\) \{\n[ \t]*const current = selectionFor\(agent\)\.current;[\s\S]*?MODEL_DOES_NOT_SUPPORT_IMAGES[\s\S]*?\n(?=[ \t]*(?:const message = createUserMessage\(\{|const durable = await durablePromptContent))/,
      [
        "// Image content is admitted regardless of the selected model's declared",
        "// input modalities: a text-only route drops the image on the wire, and",
        "// the harness's tool layer (MCP vision tools / skills) is responsible",
        "// for recognizing it when needed."
      ].join('\n') + '\n'
    )
  },
  {
    id: 'apiproxy: selectModel 处理器图片拒绝',
    pkg: 'dsh-host-apiproxy',
    already: (s) => /Model selection is admitted regardless of the session's image content/.test(s),
    anchor: (s) => /does not accept image input/.test(s),
    apply: (s) => s.replace(
      /(?:if \(pendingImage \|\| messagesHaveImage\(found\.agent\.session\.deriveMessages\(\)\)\) \{|if \(\[\.\.\.found\.agent\.inbox\.nextTurn)[\s\S]*?does not accept image input[\s\S]*?\n(?=[ \t]*const selected = \{)/,
      [
        "// Model selection is admitted regardless of the session's image content:",
        "// a text-only route drops images on the wire, and the harness's tool",
        "// layer (MCP vision tools / skills) handles recognition when needed."
      ].join('\n') + '\n'
    )
  },
  {
    id: 'deepseek 适配器 assertTextOnly',
    pkg: 'dsh-llm-deepseek',
    already: (s) => /Image blocks are no longer rejected here/.test(s),
    anchor: (s) => /The DeepSeek chat-completions adapter does not support image content\./.test(s),
    apply: (s) => s.replace(
      /\/\*\* Reject core image content[^\n]*\*\/\nfunction assertTextOnly\(blocks\) \{\n[ \t]*if \(contentHasImage\(blocks\)\) throw new LlmError\([\s\S]*?UNSUPPORTED_CONTENT"\);\n\}/,
      [
        "/** Image blocks are no longer rejected here: this wire route is text-only, so",
        " * `flattenText` drops them, and the harness's tool layer (MCP vision tools /",
        " * skills) is responsible for turning images into text before they reach the model. */",
        "function assertTextOnly(blocks) {",
        T(1) + "// no-op — image content is accepted and dropped on the wire, not rejected.",
        "}"
      ].join('\n')
    )
  },
  {
    // rc.8 新增：stream() 入口在序列化之前就按模型目录的 inputModalities 拒绝带图
    // 请求。改写为：声明了 image 模态的模型保留官方原生 data-URL 路由（rc.8 新增
    // 能力，不动）；未声明的文本模型不再抛错，attachments 保持 undefined 走纯文本
    // 序列化（assertTextOnly 已 no-op，图片在 wire 上丢弃，由 MCP 视觉工具识图）。
    // requiresRc：该拒绝代码 rc.8 才出现，识别为更早版本时整体跳过（见主流程），
    // 版本识别不出时仍按代码形状扫描兜底。
    id: 'deepseek 适配器 stream() 入口图片拒绝（rc.8）',
    pkg: 'dsh-llm-deepseek',
    requiresRc: 8,
    already: (s) => /image-capable models keep the native data-URL route/.test(s),
    anchor: (s) => /DeepSeek model .*does not accept image input/.test(s) && /DeepSeek image conversion requires the durable attachment service/.test(s),
    apply: (s) => s.replace(
      /const hasImages = options\.messages\.some\(\(message\) => contentHasImage\(message\.content\)\);\n[ \t]*let attachments;\n[ \t]*if \(hasImages\) \{\n[ \t]*if \(connection\.models\.find\(\(entry\) => entry\.id === options\.model\)\?\.inputModalities\?\.includes\("image"\) !== true\) throw new LlmError\(`DeepSeek model "\$\{options\.model\}" does not accept image input\.`, "UNSUPPORTED_CONTENT"\);\n[ \t]*attachments = this\.config\.resolveAttachments\?\.\(\);\n[ \t]*if \(attachments === void 0\) throw new LlmError\("DeepSeek image conversion requires the durable attachment service\.", "UNSUPPORTED_CONTENT"\);\n[ \t]*\}/,
      [
        [0, 'const hasImages = options.messages.some((message) => contentHasImage(message.content));'],
        [3, 'let attachments;'],
        [3, 'if (hasImages) {'],
        [4, "// Image content is admitted regardless of the catalog's declared modalities:"],
        [4, '// image-capable models keep the native data-URL route, while text-only routes'],
        [4, '// drop images on the wire and let the harness tool layer (MCP vision tools /'],
        [4, '// skills) recognize them when needed.'],
        [4, 'const supportsImage = connection.models.find((entry) => entry.id === options.model)?.inputModalities?.includes("image") === true;'],
        [4, 'if (supportsImage) {'],
        [5, 'attachments = this.config.resolveAttachments?.();'],
        [5, 'if (attachments === void 0) throw new LlmError("DeepSeek image conversion requires the durable attachment service.", "UNSUPPORTED_CONTENT");'],
        [4, '}'],
        [3, '}'],
      ].map(([n, line]) => T(n) + line).join('\n')
    )
  },
  {
    id: 'pi-ai 辅助函数 withoutImages',
    pkg: 'dsh-llm-pi-ai',
    already: (s) => /function withoutImages\(content\)/.test(s),
    anchor: (s) => /function toolResultText\(blocks\)/.test(s),
    apply: (s) => s.replace(
      /function toolResultText\(blocks\) \{\n[ \t]*return blocks\.map\([\s\S]*?\)\.join\(""\);\n\}/,
      (m) => m + '\n' + [
        "/** Deep-strip image blocks (including nested tool-result content) for a text-only",
        " * route: instead of rejecting, drop the images and let the harness's tool layer",
        " * (MCP vision tools / skills) handle recognition. */",
        "function withoutImages(content) {",
        T(1) + "return content.flatMap((block) => {",
        T(2) + 'if (block.type === "image") return [];',
        T(2) + 'if (block.type === "tool-result") return [{ ...block, content: withoutImages(block.content) }];',
        T(2) + "return [block];",
        T(1) + "});",
        "}"
      ].join('\n')
    )
  },
  {
    id: 'pi-ai stream() 非多模态不拒绝',
    pkg: 'dsh-llm-pi-ai',
    already: (s) => /const supportsImage = model\.input\.includes\("image"\);/.test(s),
    anchor: (s) => /pi-ai model .*does not support image input/.test(s),
    apply: (s) => {
      const common = /const containsImage = options\.messages\.some\(\(message\) => contentHasImage\(message\.content\)\);\n[ \t]*if \(containsImage && !model\.input\.includes\("image"\)\) throw new LlmError\([\s\S]*?UNSUPPORTED_CONTENT"\);\n[ \t]*const attachments = containsImage \? this\.config\.resolveAttachments\?\.\(\) : void 0;\n[ \t]*if \(containsImage && attachments === void 0\) throw new LlmError\("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT"\);\n/
      // rc.8：带图分支的 toPiContext 多出第 4 个参数 profile.maxRequestImageBytes，
      // 替换后原样保留该参数，与所在版本的调用签名一致。
      const rc8 = new RegExp(common.source + '([ \\t]*const onReplayDegrade = \\(reason\\) => \\{\\n[\\s\\S]*?\\n[ \\t]*\\};)\\n[ \\t]*const context = attachments === void 0 \\? toPiContext\\(options, void 0, onReplayDegrade\\) : await toPiContext\\(options, attachments, onReplayDegrade, profile\\.maxRequestImageBytes\\);')
      const withRc8 = s.replace(rc8, (_match, replayBlock) => patchedPiStream(replayBlock, ', profile.maxRequestImageBytes'))
      if (withRc8 !== s) return withRc8
      const rc7 = new RegExp(common.source + '([ \\t]*const onReplayDegrade = \\(reason\\) => \\{\\n[\\s\\S]*?\\n[ \\t]*\\};)\\n[ \\t]*const context = attachments === void 0 \\? toPiContext\\(options, void 0, onReplayDegrade\\) : await toPiContext\\(options, attachments, onReplayDegrade\\);')
      const withRc7 = s.replace(rc7, (_match, replayBlock) => patchedPiStream(replayBlock))
      if (withRc7 !== s) return withRc7
      const rc6 = new RegExp(common.source + '[ \\t]*const context = attachments === void 0 \\? toPiContext\\(options\\) : await toPiContext\\(options, attachments\\);')
      return s.replace(rc6, () => patchedPiStream())
    }
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// 安装位置发现（跨平台：只用 fs/path/os + npm）
// ─────────────────────────────────────────────────────────────────────────────

function pushRoot(set, candidate) {
  if (candidate && typeof candidate === 'string' && fs.existsSync(path.join(candidate, '@deepseek-ai'))) {
    try { set.add(fs.realpathSync(path.resolve(candidate))); }
    catch { set.add(path.resolve(candidate)); }
  }
}

function discoverRoots(argv) {
  const roots = new Set();
  const args = argv.filter((a) => !a.startsWith('--') && a !== '--self-test');
  for (const a of args) pushRoot(roots, a); // 手动指定
  const home = os.homedir();
  // npx 缓存：~/.npm/_npx/<hash>/node_modules（Windows 下为 %LocalAppData%\npm-cache\_npx\...）
  const cacheCandidates = [
    process.env.NPM_CONFIG_CACHE,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm-cache') : null,
    path.join(home, '.npm')
  ].filter(Boolean);
  for (const cache of cacheCandidates) {
    const npxDir = path.join(cache, '_npx');
    if (!fs.existsSync(npxDir)) continue;
    for (const d of fs.readdirSync(npxDir)) pushRoot(roots, path.join(npxDir, d, 'node_modules'));
  }
  // 全局安装（npm root -g 指向直接包含 @deepseek-ai 的目录）
  try {
    const g = execSync('npm root -g', { shell: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    pushRoot(roots, g);
  } catch { /* 无 npm 或查询失败则跳过 */ }
  // 当前目录本地安装
  pushRoot(roots, path.join(process.cwd(), 'node_modules'));
  return [...roots];
}

// 渠道适配器包（dsh-llm-deepseek / dsh-llm-pi-ai）只是各 LLM 渠道的接入层：
// 用户可能根本没配该渠道，补丁跟不上 dsh 新结构时卡死整个安装并不合理——
// 降级为警告并说清后果（真用该渠道拖图会被官方拒绝）。宿主核心
// dsh-host-apiproxy 所有渠道必经，失配仍算失败。
const ADAPTER_PATCH_PACKAGES = new Set(['dsh-llm-deepseek', 'dsh-llm-pi-ai']);

function pkgJsFiles(root, pkg) {
  const dir = path.join(root, '@deepseek-ai', pkg);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(path.join(d, e.name)); }
      else if (e.name.endsWith('.js') && !e.name.endsWith('.map')) out.push(path.join(d, e.name));
    }
  })(dir);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 自测：用「补丁前」的原始代码片段验证正则在新结构下依然成立
// ─────────────────────────────────────────────────────────────────────────────

function selfTest() {
  const S1 = [
    T(4) + 'const hasImage = content.some((part) => part.type === "image");',
    T(4) + 'const admit = async () => {',
    T(5) + 'try {',
    T(6) + 'if (hasImage) {',
    T(7) + 'const current = selectionFor(agent).current;',
    T(7) + 'const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);',
    T(7) + 'if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {',
    T(8) + 'code: "attachment-error",',
    T(8) + 'message: `Model "${current.model}" does not support image input.`,',
    T(8) + 'details: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" }',
    T(7) + '});',
    T(6) + '}',
    T(6) + 'const message = createUserMessage({'
  ].join('\n');
  const S2 = [
    T(6) + 'if ([...found.agent.inbox.nextTurn, ...found.agent.inbox.nextStep].some((message) => contentHasImage(message.content)) || messagesHaveImage(found.agent.session.deriveMessages())) {',
    T(7) + 'const info = await ctx.llm.resolveModelInfo(resolved.provider, resolved.model);',
    T(7) + 'if (info.inputModalities !== void 0 && !info.inputModalities.includes("image")) return err(request, {',
    T(8) + 'code: "model-unavailable",',
    T(8) + 'message: `Model "${resolved.model}" does not accept image input, but this session already contains images; select an image-capable model.`,',
    T(8) + 'details: {',
    T(9) + 'provider,',
    T(9) + 'model',
    T(8) + '}',
    T(7) + '});',
    T(6) + '}',
    T(6) + 'const selected = {'
  ].join('\n');
  const S3 = [
    '/** Reject core image content before any text-flattening path can silently erase it. */',
    'function assertTextOnly(blocks) {',
    T(1) + 'if (contentHasImage(blocks)) throw new LlmError("The DeepSeek chat-completions adapter does not support image content.", "UNSUPPORTED_CONTENT");',
    '}'
  ].join('\n');
  const S4 = [
    'function toolResultText(blocks) {',
    T(1) + 'return blocks.map((block) => block.type === "text" ? block.text : block.type === "tool-result" ? toolResultText(block.content) : "").join("");',
    '}'
  ].join('\n');
  // 多行变体（lib/types/api-proxy.js 的未压缩源码形态，4 空格缩进、单引号）
  const SP = (n) => '    '.repeat(n);
  const S1b = [
    SP(6) + 'if (hasImage) {',
    SP(7) + 'const current = selectionFor(agent).current;',
    SP(7) + 'const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);',
    SP(7) + "if (modelInfo.inputModalities !== undefined && !modelInfo.inputModalities.includes('image')) {",
    SP(8) + "return err(request, {",
    SP(8) + "code: 'attachment-error',",
    SP(8) + 'message: `Model "${current.model}" does not support image input.`,',
    SP(8) + "details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },",
    SP(7) + '});',
    SP(6) + '}',
    SP(6) + 'const durable = await durablePromptContent(ctx, content);'
  ].join('\n');
  const S2b = [
    SP(6) + 'const pendingImage = [...found.agent.inbox.nextTurn, ...found.agent.inbox.nextStep]',
    SP(7) + '.some(message => contentHasImage(message.content));',
    SP(6) + 'if (pendingImage || messagesHaveImage(found.agent.session.deriveMessages())) {',
    SP(7) + 'const info = await ctx.llm.resolveModelInfo(resolved.provider, resolved.model);',
    SP(7) + "if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {",
    SP(8) + "return err(request, {",
    SP(8) + "code: 'model-unavailable',",
    SP(8) + 'message: `Model "${resolved.model}" does not accept image input, but this session already contains images; select an image-capable model.`,',
    SP(8) + 'details: { provider, model },',
    SP(7) + '});',
    SP(6) + '}',
    SP(6) + '}',
    SP(6) + 'const selected = {'
  ].join('\n');
  const S5 = [
    T(4) + 'const containsImage = options.messages.some((message) => contentHasImage(message.content));',
    T(4) + 'if (containsImage && !model.input.includes("image")) throw new LlmError(`pi-ai model "${model.id}" does not support image input`, "UNSUPPORTED_CONTENT");',
    T(4) + 'const attachments = containsImage ? this.config.resolveAttachments?.() : void 0;',
    T(4) + 'if (containsImage && attachments === void 0) throw new LlmError("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT");',
    T(4) + 'const context = attachments === void 0 ? toPiContext(options) : await toPiContext(options, attachments);'
  ].join('\n');
  const S5rc7 = [
    T(4) + 'const containsImage = options.messages.some((message) => contentHasImage(message.content));',
    T(4) + 'if (containsImage && !model.input.includes("image")) throw new LlmError(`pi-ai model "${model.id}" does not support image input`, "UNSUPPORTED_CONTENT");',
    T(4) + 'const attachments = containsImage ? this.config.resolveAttachments?.() : void 0;',
    T(4) + 'if (containsImage && attachments === void 0) throw new LlmError("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT");',
    T(4) + 'const onReplayDegrade = (reason) => {',
    T(5) + 'this.config.onReplayDegrade?.({',
    T(6) + 'provider: options.provider,',
    T(6) + 'model: options.model,',
    T(6) + 'reason',
    T(5) + '});',
    T(4) + '};',
    T(4) + 'const context = attachments === void 0 ? toPiContext(options, void 0, onReplayDegrade) : await toPiContext(options, attachments, onReplayDegrade);'
  ].join('\n');
  // rc.8：stream() 入口的 toPiContext 带图分支多出第 4 个参数
  const S5rc8 = [
    T(4) + 'const containsImage = options.messages.some((message) => contentHasImage(message.content));',
    T(4) + 'if (containsImage && !model.input.includes("image")) throw new LlmError(`pi-ai model "${model.id}" does not support image input`, "UNSUPPORTED_CONTENT");',
    T(4) + 'const attachments = containsImage ? this.config.resolveAttachments?.() : void 0;',
    T(4) + 'if (containsImage && attachments === void 0) throw new LlmError("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT");',
    T(4) + 'const onReplayDegrade = (reason) => {',
    T(5) + 'this.config.onReplayDegrade?.({',
    T(6) + 'provider: options.provider,',
    T(6) + 'model: options.model,',
    T(6) + 'reason',
    T(5) + '});',
    T(4) + '};',
    T(4) + 'const context = attachments === void 0 ? toPiContext(options, void 0, onReplayDegrade) : await toPiContext(options, attachments, onReplayDegrade, profile.maxRequestImageBytes);'
  ].join('\n');
  // rc.8：deepseek 适配器 stream() 入口按模型目录 inputModalities 拒绝带图请求
  const S6rc8 = [
    T(3) + 'const hasImages = options.messages.some((message) => contentHasImage(message.content));',
    T(3) + 'let attachments;',
    T(3) + 'if (hasImages) {',
    T(4) + 'if (connection.models.find((entry) => entry.id === options.model)?.inputModalities?.includes("image") !== true) throw new LlmError(`DeepSeek model "${options.model}" does not accept image input.`, "UNSUPPORTED_CONTENT");',
    T(4) + 'attachments = this.config.resolveAttachments?.();',
    T(4) + 'if (attachments === void 0) throw new LlmError("DeepSeek image conversion requires the durable attachment service.", "UNSUPPORTED_CONTENT");',
    T(3) + '}'
  ].join('\n');

  const cases = [
    { id: 'apiproxy: prompt 提交处理器图片拒绝', before: S1, mustHave: 'Image content is admitted regardless', mustNotHave: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    { id: 'apiproxy: prompt 提交处理器图片拒绝', before: S1b, mustHave: 'Image content is admitted regardless', mustNotHave: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    { id: 'apiproxy: selectModel 处理器图片拒绝', before: S2, mustHave: 'Model selection is admitted regardless', mustNotHave: 'does not accept image input' },
    { id: 'apiproxy: selectModel 处理器图片拒绝', before: S2b, mustHave: 'Model selection is admitted regardless', mustNotHave: 'does not accept image input' },
    { id: 'deepseek 适配器 assertTextOnly', before: S3, mustHave: 'no-op', mustNotHave: 'does not support image content' },
    { id: 'pi-ai 辅助函数 withoutImages', before: S4, mustHave: 'function withoutImages(content)', mustNotHave: '' },
    { id: 'pi-ai stream() 非多模态不拒绝', before: S5, mustHave: 'const supportsImage', mustNotHave: 'does not support image input' },
    { id: 'pi-ai stream() 非多模态不拒绝', before: S5rc7, mustHave: 'onReplayDegrade', mustNotHave: 'does not support image input' },
    { id: 'pi-ai stream() 非多模态不拒绝', before: S5rc8, mustHave: 'profile.maxRequestImageBytes', mustNotHave: 'does not support image input' },
    { id: 'deepseek 适配器 stream() 入口图片拒绝（rc.8）', before: S6rc8, mustHave: 'const supportsImage', mustNotHave: 'does not accept image input' }
  ];
  let failed = 0;
  for (const c of cases) {
    const p = patches.find((x) => x.id === c.id);
    const problems = [];
    if (!p.anchor(c.before)) problems.push('anchor 未匹配');
    if (p.already(c.before)) problems.push('already 误判为已打');
    const after = p.apply(c.before);
    if (after === c.before) problems.push('apply 未产生变化');
    if (!p.already(after)) problems.push('补丁后 already 仍为 false');
    if (c.mustHave && !after.includes(c.mustHave)) problems.push(`缺少 ${c.mustHave}`);
    if (c.mustNotHave && after.includes(c.mustNotHave)) problems.push(`残留 ${c.mustNotHave}`);
    if (problems.length) { failed++; console.error(`✗ ${c.id}: ${problems.join('; ')}`); }
    else console.log(`✓ ${c.id}`);
  }
  console.log(failed === 0 ? 'SELF-TEST PASS' : `SELF-TEST FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

// 事务化写入：原始内容先留在内存里，写入走 temp+rename 原子替换（进程中断也
// 不会留下写了一半的文件）。任何失败（结构不匹配 / 语法校验失败）都把本次已
// 写入的全部文件恢复到补丁前状态——绝不留下半补丁安装（一部分文件打了、
// 另一部分没打且行为混杂）。
const originals = new Map();

function writeAtomic(file, content) {
  const temp = `${file}.visionpower-${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

function rollbackWrittenFiles() {
  let restored = 0;
  for (const [file, before] of originals) {
    try { writeAtomic(file, before); restored++; }
    catch (e) { console.error(`  ✗ 回滚失败: ${file}（${e.message}）——该文件需手动恢复`); }
  }
  if (restored > 0) console.error(`已将 ${restored} 个已写入文件回滚到补丁前状态。`);
  originals.clear();
  return restored;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const dryRun = argv.includes('--dry-run');

  const roots = discoverRoots(argv);
  if (roots.length === 0) {
    console.error('[patch-dsh] 未找到 DSH 安装（含 @deepseek-ai 的 node_modules）。');
    console.error('           请手动指定：node patch-dsh.mjs <node_modules 根目录>');
    process.exit(2);
  }

  let applied = 0, alreadyOk = 0, structureFail = 0, adapterSkipped = 0, touched = [];
  for (const root of roots) {
    console.log(`\n== 安装位置: ${root}`);
    // 版本戳：打印该安装的 dsh 版本并识别补丁集，便于对照适用性。
    // 补丁的应用始终按代码形状自选（锚点只命中对应版本的源码结构），
    // 这里的识别用于把「启用了哪套补丁」讲清楚，并让 rc.8+ 专属补丁
    // （requiresRc）在更早版本上整体跳过、不产生误导演报；识别不出
    // 版本号时不设限，仍按代码形状兜底扫描。
    let rootRc = null;
    try {
      const dshPkg = JSON.parse(fs.readFileSync(path.join(root, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
      console.log(`   dsh 版本: ${dshPkg.version}（补丁覆盖 0.1.0-rc.6 / rc.7 / rc.8）`);
      const rc = /^0\.1\.0-rc\.(\d+)$/.exec(dshPkg.version);
      if (rc) rootRc = Number(rc[1]);
      if (rootRc !== null && rootRc >= 8) {
        console.log('   识别为 rc.8+：启用 rc.8 补丁集（deepseek stream() 入口放行 + pi-ai maxRequestImageBytes 变体；声明了 image 模态的模型保留官方原生发图路由）');
      } else if (rootRc !== null && rootRc >= 6) {
        console.log('   识别为 rc.8 之前的版本：沿用 rc.6 / rc.7 补丁集');
      } else if (rootRc !== null) {
        console.warn('   识别为 rc.6 之前的版本：不在补丁覆盖范围内，若补丁结果异常请升级本脚本');
      } else {
        console.warn('   无法识别的 dsh 版本号：补丁将按代码形状自动匹配，若失败请升级本脚本');
      }
    } catch { /* 无 dsh 主包则跳过 */ }
    for (const p of patches) {
      if (p.requiresRc !== undefined && rootRc !== null && rootRc < p.requiresRc) {
        console.log(`  - ${p.id}\n    dsh 版本早于 rc.${p.requiresRc}，无此拒绝代码，跳过`);
        continue;
      }
      const files = pkgJsFiles(root, p.pkg);
      if (files.length === 0) { console.log(`  - ${p.id}\n    包不存在，跳过`); continue; }
      let foundAny = false;
      for (const file of files) {
        const rel = path.relative(root, file);
        const before = fs.readFileSync(file, 'utf8');
        if (p.already(before)) { alreadyOk++; foundAny = true; console.log(`  ✓ ${p.id}  [${rel}] 已打过`); continue; }
        if (!p.anchor(before)) continue; // 无关文件静默跳过
        foundAny = true;
        const after = p.apply(before);
        if (after === before) {
          if (ADAPTER_PATCH_PACKAGES.has(p.pkg)) {
            adapterSkipped++;
            console.warn(`  ⚠ ${p.id}  [${rel}] 锚点存在但替换失败——dsh 结构已变。若你在 dsh 使用该渠道（${p.pkg}），拖图识图会被官方拒绝；不影响其他渠道。升级 VisionPower 后重跑可修复`);
          } else {
            structureFail++;
            console.error(`  ✗ ${p.id}  [${rel}] 锚点存在但替换失败——版本结构已变，需按配置提示词手动修改`);
          }
          continue;
        }
        if (!dryRun) {
          if (!originals.has(file)) originals.set(file, before);
          writeAtomic(file, after);
          touched.push(file);
        }
        applied++;
        console.log(`  ● ${p.id}  [${rel}] ${dryRun ? '待打补丁（dry-run，未写入）' : '已打补丁'}`);
      }
      // 响亮失败：包存在却找不到任何旧拒绝代码（可能 dsh 版本已更新），不能静默跳过；
      // 渠道适配器包例外——用户可能没配该渠道，降级为警告。
      if (!foundAny) {
        if (ADAPTER_PATCH_PACKAGES.has(p.pkg)) {
          adapterSkipped++;
          console.warn(`  ⚠ ${p.id}  未发现旧拒绝代码——可能官方已移除或 dsh 结构已变。若你在 dsh 使用该渠道（${p.pkg}）且拖图被拒，升级 VisionPower 后重跑；不影响其他渠道`);
        } else {
          structureFail++;
          console.error(`  ⚠ ${p.id}  未发现旧拒绝代码——dsh 版本可能已更新或官方已修复，请升级 patch-dsh.mjs 后重试`);
        }
      }
    }
  }

  // 语法校验所有被修改的文件
  let syntaxFail = 0;
  for (const file of touched) {
    const r = spawnSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.status !== 0) { syntaxFail++; console.error(`  ✗ node --check 失败: ${file}\n${r.stderr}`); }
  }

  // 事务收尾：结构不匹配（dsh 结构漂移，本次补丁无法完整应用）或语法失败都
  // 意味着安装会停在行为混杂的半补丁状态——一部分文件放行图片、另一部分仍
  // 拒绝——回滚本次写入的全部文件，回到干净的补丁前状态后退出报错。
  let rolledBack = 0;
  if ((syntaxFail > 0 || structureFail > 0) && !dryRun) rolledBack = rollbackWrittenFiles();

  // 提示：识图规则默认由 visionpower 插件在运行时注入，无需 AGENTS.md 文件（可选写入）。
  // 路径按 ~ 缩写展示，避免打印绝对路径让人误以为是硬编码。
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const agents = path.join(dshHome, 'AGENTS.md');
  const agentsDisplay = agents.split(os.homedir())[0] === '' ? agents.replace(os.homedir(), '~') : agents;
  if (!fs.existsSync(agents)) console.log(`\nℹ 识图规则默认由 visionpower 插件运行时注入，无需 ${agentsDisplay}；如需可见可编辑的规则文件，运行 setup-dsh --write-agents 写入。`);

  console.log('\n──────────────────────────────────────────');
  console.log(`应用补丁 ${applied} 处，已打过 ${alreadyOk} 处，结构不匹配 ${structureFail} 处，语法失败 ${syntaxFail} 处${adapterSkipped > 0 ? `，渠道适配器跳过 ${adapterSkipped} 处（不影响其他渠道）` : ''}${rolledBack > 0 ? `（已回滚 ${rolledBack} 个文件的写入）` : ''}${dryRun ? '（dry-run，未写入任何文件）' : ''}。`);
  if (applied > 0 && !dryRun) console.log('请重启 DSH 生效：npm exec @deepseek-ai/dsh web');
  if (syntaxFail > 0 || structureFail > 0) {
    console.error('存在未解决的问题，请按上面的 ✗ 提示手动处理。');
    process.exit(1);
  }
  if (applied === 0 && alreadyOk === 0) {
    console.error('一个补丁都没有找到可应用位置，请确认安装位置是否正确。');
    process.exit(2);
  }
  console.log('完成。');
}

main();
