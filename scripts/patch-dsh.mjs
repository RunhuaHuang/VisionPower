#!/usr/bin/env node
// patch-dsh.mjs —— DSH「拖图不拒绝」跨平台补丁脚本（Windows / macOS / Linux）
//
// 用途：DSH 升级 / npx 重装后，官方源码自带的「图片拒绝」逻辑会回来。
//       更新后运行一次本脚本，自动重打全部补丁（幂等，可重复运行）。
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
    apply: (s) => s.replace(
      /const containsImage = options\.messages\.some\(\(message\) => contentHasImage\(message\.content\)\);\n[ \t]*if \(containsImage && !model\.input\.includes\("image"\)\) throw new LlmError\([\s\S]*?UNSUPPORTED_CONTENT"\);\n[ \t]*const attachments = containsImage \? this\.config\.resolveAttachments\?\.\(\) : void 0;\n[ \t]*if \(containsImage && attachments === void 0\) throw new LlmError\("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT"\);\n[ \t]*const context = attachments === void 0 \? toPiContext\(options\) : await toPiContext\(options, attachments\);/,
      [
        "const containsImage = options.messages.some((message) => contentHasImage(message.content));",
        'const supportsImage = model.input.includes("image");',
        "const messages = containsImage && !supportsImage",
        "? options.messages.map((message) => ({ ...message, content: withoutImages(message.content) }))",
        ": options.messages;",
        "const attachments = containsImage && supportsImage ? this.config.resolveAttachments?.() : void 0;",
        'if (containsImage && supportsImage && attachments === void 0) throw new LlmError("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT");',
        "const context = attachments === void 0 ? toPiContext({ ...options, messages }) : await toPiContext({ ...options, messages }, attachments);"
      ].map((line, i) => (i === 3 || i === 4 ? T(4) + T(1) : T(4)) + line).join('\n')
    )
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

  const cases = [
    { id: 'apiproxy: prompt 提交处理器图片拒绝', before: S1, mustHave: 'Image content is admitted regardless', mustNotHave: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    { id: 'apiproxy: prompt 提交处理器图片拒绝', before: S1b, mustHave: 'Image content is admitted regardless', mustNotHave: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    { id: 'apiproxy: selectModel 处理器图片拒绝', before: S2, mustHave: 'Model selection is admitted regardless', mustNotHave: 'does not accept image input' },
    { id: 'apiproxy: selectModel 处理器图片拒绝', before: S2b, mustHave: 'Model selection is admitted regardless', mustNotHave: 'does not accept image input' },
    { id: 'deepseek 适配器 assertTextOnly', before: S3, mustHave: 'no-op', mustNotHave: 'does not support image content' },
    { id: 'pi-ai 辅助函数 withoutImages', before: S4, mustHave: 'function withoutImages(content)', mustNotHave: '' },
    { id: 'pi-ai stream() 非多模态不拒绝', before: S5, mustHave: 'const supportsImage', mustNotHave: 'does not support image input' }
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

  let applied = 0, alreadyOk = 0, structureFail = 0, touched = [];
  for (const root of roots) {
    console.log(`\n== 安装位置: ${root}`);
    // 版本戳：打印该安装的 dsh 版本，便于对照补丁适用性（补丁按 0.1.0-rc.6 结构编写）
    try {
      const dshPkg = JSON.parse(fs.readFileSync(path.join(root, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
      console.log(`   dsh 版本: ${dshPkg.version}（补丁按 0.1.0-rc.6 结构编写，版本差异较大时请升级本脚本）`);
    } catch { /* 无 dsh 主包则跳过 */ }
    for (const p of patches) {
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
          structureFail++;
          console.error(`  ✗ ${p.id}  [${rel}] 锚点存在但替换失败——版本结构已变，需按配置提示词手动修改`);
          continue;
        }
        if (!dryRun) fs.writeFileSync(file, after);
        applied++;
        if (!dryRun) touched.push(file);
        console.log(`  ● ${p.id}  [${rel}] ${dryRun ? '待打补丁（dry-run，未写入）' : '已打补丁'}`);
      }
      // 响亮失败：包存在却找不到任何旧拒绝代码（可能 dsh 版本已更新），不能静默跳过
      if (!foundAny) {
        structureFail++;
        console.error(`  ⚠ ${p.id}  未发现旧拒绝代码——dsh 版本可能已更新或官方已修复，请升级 patch-dsh.mjs 后重试`);
      }
    }
  }

  // 语法校验所有被修改的文件
  let syntaxFail = 0;
  for (const file of touched) {
    const r = spawnSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.status !== 0) { syntaxFail++; console.error(`  ✗ node --check 失败: ${file}\n${r.stderr}`); }
  }

  // 提示：识图规则默认由 visionpower 插件在运行时注入，无需 AGENTS.md 文件（可选写入）
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const agents = path.join(dshHome, 'AGENTS.md');
  if (!fs.existsSync(agents)) console.log(`\nℹ 识图规则默认由 visionpower 插件运行时注入，无需 ${agents}；如需可见可编辑的规则文件，运行 setup-dsh --write-agents 写入。`);

  console.log('\n──────────────────────────────────────────');
  console.log(`应用补丁 ${applied} 处，已打过 ${alreadyOk} 处，结构不匹配 ${structureFail} 处，语法失败 ${syntaxFail} 处${dryRun ? '（dry-run，未写入任何文件）' : ''}。`);
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
