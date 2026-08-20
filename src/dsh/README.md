# visionpower/dsh —— VisionPower 的 dsh 原生 Cordis 插件

把 `describe_image` 注册为 DeepSeek Harness (dsh) 的**一等原生工具**：同进程直调 VisionPower 内核，无 MCP 子进程、无 JSON-RPC、无冷启动超时，并支持协作式取消（dsh 取消调用时立即中止上游请求）。

本插件**随主包 `visionpower` 一起发布**（子路径 `visionpower/dsh`），与 MCP（`src/index.js`）和 Skill（`VisionPower-Skill/`）三形态共存于同一个包，共享同一份内核，不需要任何单独的 npm 包。

当前兼容基线为 **dsh `0.1.0-rc.8`**（补丁兼容 `rc.6` – `rc.8`，`scripts/patch-dsh.mjs` 按代码形状自动匹配所装版本）。rc.7 起图片作为持久化、不透明附件管理；插件通过宿主 `AttachmentStore.readImage()` 读取并校验字节，绝不解析附件 ID 或推导宿主的落盘路径。rc.8 起 dsh 官方支持给声明了 `inputModalities: [text, image]` 的模型原生直发图片，补丁保留该路由；纯文本模型的图片消息仍由补丁放行（线上丢弃），由本插件的 `describe_image` 识图。

## 安装与挂载

推荐用一键安装器（详见主 README「一行命令安装」）：

```bash
npx -y visionpower@3.2.1 setup-dsh --launch
```

手动安装：

```bash
# 方式一：npm registry（国内可配 npmmirror）
dsh plugin --profile web add visionpower

# 方式二：GitHub 源
dsh plugin --profile web add github:RunhuaHuang/VisionPower

# 方式三：本地开发（file: 指向仓库根目录）
dsh plugin --profile web add file:/path/to/VisionPower
```

在 profile 的 `cordis.patch.yml` 中 insert 一行（所有配置项均可选）：

```yaml
- insert:
    - id: visionpower
      name: 'visionpower/dsh'
      config:
        # 全部可选，不写则沿用 ~/.visionpower/config.json 与环境变量
        model: MiniMax-M3
        baseUrl: https://api.minimaxi.com/v1
        timeoutMs: 120000
        injectRules: true    # 运行时注入识图规则（默认 true）
        debug: false
```

重启 `dsh web` 后，模型即可看到原生工具 **`describe_image`**（不再有 `mcp__` 前缀）。同时可在 **Settings → Plugins → VisionPower** 打开配置页，开启或关闭 dsh 中的 VisionPower、选择模型、填写 API Key、测试连通性。dsh 开关切换后立即保存并生效；其他字段点击“保存并应用配置”后生效，无需手动编辑配置文件。开关仅影响 dsh 的规则注入与 dsh `describe_image`，不会关闭 MCP、Skill 或独立 WebUI；MCP Node 进程由对应宿主管理。高权限的 **`setup_visionpower`** 管理工具默认不注册；仅当运维人员显式配置 `enableAdminTool: true` 时启用。

## 拖图 / 粘贴识图闭环

「把图片**拖进**或**粘贴**（Cmd/Ctrl+V）进会话」在纯文本模型路由下能识图，靠三件套配合（一键安装器 `setup-dsh` 会全部就位）：

1. **插件本体**：`describe_image` 就是一个**普通工具**——agent 在正常工具调用阶段按需调用，dsh 界面有可见进度，每张图一次视觉调用，回合开始绝不被识图阻塞。外加一项零操作能力（`config` 可关）：
   - **规则注入**（`injectRules`，默认开，运维可在 cordis 配置里关）：把识图规则（`src/dsh/rules.js`，单一来源）注入 agent 上下文——**只在图片相关回合注入**（消息带图 / 文本提到图 / 纯图片空文本），纯文本回合零打扰。规则让纯文本模型直接调用 `describe_image`；工具会通过 rc.7 附件服务自动读取当前会话中最近一条带图用户消息，真多模态模型仍直接看图作答。
2. **服务端补丁**（`scripts/patch-dsh.mjs`）：移除 dsh 对纯文本模型路由的图片消息拒绝（否则拖图/粘贴在服务端就被 `Model does not support image input` 拦下）。幂等；dsh 升级/重装后重跑 `setup-dsh` 自动重打。
3. **识图规则**（`src/dsh/rules.js`）：默认走插件运行时注入（Route A，不写用户文件）；`setup-dsh --write-agents` 可改为追加进 `~/.dsh/AGENTS.md`（Route B，规则可见可编辑）。两条通道读同一模块，文本永不漂移。

三件套就位后**重启 dsh web** 生效（web 的 HMR 关闭）。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `dshEnabled` | true | dsh 专用开关；关闭后 dsh 不注入规则，dsh 识图请求会被拒绝；MCP/Skill/WebUI 不受影响 |
| `model` | 配置文件/环境 | 视觉模型名（如 `qwen3-vl-flash`、`MiniMax-M3`、`gpt-5.6`） |
| `baseUrl` | 配置文件/环境 | OpenAI 兼容端点，覆盖 `VISIONPOWER_BASE_URL` |
| `protocol` | 按模型/端点推断 | `openai` 或 `anthropic`；覆盖 `baseUrl` 时建议显式指定 |
| `apiKeyEnv` | 无 | 从指定环境变量读取 API Key（如 `VISIONPOWER_API_KEY`） |
| `configPath` | `~/.visionpower/config.json` | 覆盖配置文件路径 |
| `timeoutMs` | 60000 | 上游模型请求超时（毫秒）；上游视觉模型偶发较慢，建议 120000 |
| `firstByteTimeoutMs` | 15000 | 首字响应超时（毫秒）：流式请求若在此时限内未吐出首个字符则提前中断并重试，不超过 `timeoutMs` |
| `injectRules` | true | 在图片相关回合注入识图规则（消息带图 / 文本提到图 / 纯图片空文本；上下文或 `~/.dsh/AGENTS.md` 已有规则时跳过） |
| `debug` | false | 输出 `[visionpower]` 调试日志到 stderr |

模型等插件覆盖项的优先级：**cordis.patch.yml 配置 > 环境变量 > `~/.visionpower/config.json`**。`dshEnabled` 由 Settings、`VISIONPOWER_DSH_ENABLED` 或配置文件管理，不接受 Cordis profile 覆盖，以便保存后立即生效。API Key 建议继续放在 `~/.visionpower/config.json`（mode 600），不写进 cordis.yml。

## 工具参数（与 MCP 形态一致）

当前 dsh 消息带图时，可省略所有图片字段，只传 `prompt` / `output_format`；插件会按消息中的图片顺序读取附件。`image_path` / `image_url` / `image_base64` / `image_ref` / `images[]` / `image_mime_type` 仍可显式传入，语义与主 README「接口参考」完全一致。

不要从 dsh 的 `attachmentId` 推导 `image_path`：rc.7 明确将它定义为不透明标识。只有用户本来就提供了真实本地文件路径时才使用 `image_path`。

## ⚠️ 安装陷阱（重要）

插件对 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm` / `@deepseek-ai/schemastery` 的依赖是**可选 peer 依赖**（`peerDependenciesMeta.optional`），普通 npm 安装不会把它们带进 profile。

dsh 启动时会把这些内置包从安装目录软链到 `$DSH_HOME/profiles/node_modules` 作为回退，插件的 peer import 自动解析到**与 harness 完全相同的副本**（保证内部 Symbol 一致）。

**不要**：

- 把这些包手动装成 profile 直接依赖；
- 开启 `autoInstallPeers`。

否则 profile 内的副本会遮蔽该回退，导致工具调度器 Symbol 错位，所有工具调用报 `Cannot read properties of undefined (reading 'prepare')`。

## 开发（仓库根目录执行）

```bash
npm run build:dsh   # 重新生成 src/dsh/core.bundle.js（内核改动后必须执行）
npm run build:skill # 重新生成 Skill 脚本（内核改动后必须执行）
npm test            # 全量测试，含三形态同步校验
npm run lint        # 静态检查
```
