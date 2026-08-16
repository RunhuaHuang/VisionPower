# visionpower/dsh —— VisionPower 的 dsh 原生 Cordis 插件

把 `describe_image` 注册为 DeepSeek Harness (dsh) 的**一等原生工具**：同进程直调 VisionPower 内核，无 MCP 子进程、无 JSON-RPC、无冷启动超时，并支持协作式取消（dsh 取消调用时立即中止上游请求）。

本插件**随主包 `visionpower` 一起发布**（子路径 `visionpower/dsh`），与 MCP（`src/index.js`）和 Skill（`VisionPower-Skill/`）三形态共存于同一个包，共享同一份内核，不需要任何单独的 npm 包。

## 安装与挂载

推荐用一键安装器（详见主 README「一行命令安装」）：

```bash
npx -y visionpower@latest setup-dsh --launch
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
        autoDescribe: true   # 自动识图（默认 true）
        injectRules: true    # 运行时注入识图规则（默认 true）
        debug: false
```

重启 `dsh web` 后，模型即可看到原生工具 **`describe_image`**（不再有 `mcp__` 前缀）。

## 拖图 / 粘贴识图闭环

「把图片**拖进**或**粘贴**（Cmd/Ctrl+V）进会话」在纯文本模型路由下能识图，靠三件套配合（一键安装器 `setup-dsh` 会全部就位）：

1. **插件本体**：提供 `describe_image` 工具，外加两项零操作能力（`config` 可关）：
   - **自动识图**（`autoDescribe`，默认开）：监听 `session/event`，用户消息带 image 块（拖拽与粘贴流程完全相同）时自动读取附件字节、调用视觉内核，把描述经 `agent/pre-step` 注入下一轮上下文--用户不提「图」字也能被识别；失败/超时自动降级为规则兜底。
   - **规则注入**（`injectRules`，默认开）：把「图片定位与识图规则」（`src/dsh/rules.js`，单一来源）注入 agent 上下文；上下文或 `~/.dsh/AGENTS.md` 已有相同规则时自动跳过。**每轮至多一条 VisionPower 注入**：自动识图成功时只注精简描述（规则冗余、跳过）；识图失败/超时把规则并入同一条兜底消息；无图或关闭自动识图时才单独注入规则。
2. **服务端补丁**（`scripts/patch-dsh.mjs`）：移除 dsh 对纯文本模型路由的图片消息拒绝（否则拖图/粘贴在服务端就被 `Model does not support image input` 拦下）。幂等；dsh 升级/重装后重跑 `setup-dsh` 自动重打。
3. **识图规则**（`src/dsh/rules.js`）：默认走插件运行时注入（Route A，不写用户文件）；`setup-dsh --write-agents` 可改为追加进 `~/.dsh/AGENTS.md`（Route B，规则可见可编辑）。两条通道读同一模块，文本永不漂移。

三件套就位后**重启 dsh web** 生效（web 的 HMR 关闭）。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `model` | 配置文件/环境 | 视觉模型名（如 `qwen3-vl-flash`、`MiniMax-M3`、`gpt-5.6`） |
| `baseUrl` | 配置文件/环境 | OpenAI 兼容端点，覆盖 `VISIONPOWER_BASE_URL` |
| `apiKeyEnv` | 无 | 从指定环境变量读取 API Key（如 `VISIONPOWER_API_KEY`） |
| `configPath` | `~/.visionpower/config.json` | 覆盖配置文件路径 |
| `timeoutMs` | 60000 | 上游模型请求超时（毫秒）；上游视觉模型偶发较慢，建议 120000 |
| `firstByteTimeoutMs` | 15000 | 首字响应超时（毫秒）：流式请求若在此时限内未吐出首个字符则提前中断并重试，不超过 `timeoutMs` |
| `autoDescribe` | true | 自动识图：消息带图时自动预跑视觉内核并注入描述 |
| `autoDescribeWaitMs` | 15000 | 自动识图结果的最大等待毫秒数；超时立即退回规则链路，不让回合长时间无反馈 |
| `injectRules` | true | 每轮注入识图规则（已存在则跳过） |
| `debug` | false | 输出 `[visionpower]` 调试日志到 stderr |

优先级：**cordis.yml 配置 > 环境变量 > `~/.visionpower/config.json`**。API Key 建议继续放在 `~/.visionpower/config.json`（mode 600），不写进 cordis.yml。

## 工具参数（与 MCP 形态一致）

`image_path` / `image_url` / `image_base64` / `image_ref` / `images[]` / `image_mime_type` / `prompt` / `output_format`，语义与主 README「接口参考」完全一致。

**无扩展名文件**：dsh 会把拖入的图片以内容寻址方式存成无扩展名文件。`image_path` 可直接传这类路径——内核按 magic bytes 自动识别六种格式（JPEG/PNG/WEBP/GIF/BMP/TIFF），无需复制或加后缀；非空且未知的扩展名仍会被拒绝，有扩展名时内容与扩展名必须一致。

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
