# visionpower/dsh —— VisionPower 的 dsh 原生 Cordis 插件

把 `describe_image` 注册为 DeepSeek Harness (dsh) 的**一等原生工具**：同进程直调 VisionPower 内核，无 MCP 子进程、无 JSON-RPC、无冷启动超时，并支持协作式取消（dsh 取消调用时立即中止上游请求）。

本插件**随主包 `visionpower` 一起发布**（子路径 `visionpower/dsh`），与 MCP（`src/index.js`）和 Skill（`VisionPower-Skill/`）三形态共存于同一个包，共享同一份内核，不需要任何单独的 npm 包。

## 安装与挂载

```bash
# 方式一：npm 发布后
dsh plugin --profile web add visionpower

# 方式二：本地开发（file: 指向仓库根目录）
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
        debug: false
```

重启 `dsh web` 后，模型即可看到原生工具 **`describe_image`**（不再有 `mcp__` 前缀）。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `model` | 配置文件/环境 | 视觉模型名（如 `qwen3-vl-flash`、`MiniMax-M3`、`gpt-5.6`） |
| `baseUrl` | 配置文件/环境 | OpenAI 兼容端点，覆盖 `VISIONPOWER_BASE_URL` |
| `apiKeyEnv` | 无 | 从指定环境变量读取 API Key（如 `VISIONPOWER_API_KEY`） |
| `configPath` | `~/.visionpower/config.json` | 覆盖配置文件路径 |
| `timeoutMs` | 60000 | 上游模型请求超时（毫秒）；上游视觉模型偶发较慢，建议 120000 |
| `firstByteTimeoutMs` | 15000 | 首字响应超时（毫秒）：流式请求若在此时限内未吐出首个字符则提前中断并重试，不超过 `timeoutMs` |
| `debug` | false | 输出 `[visionpower]` 调试日志到 stderr |

优先级：**cordis.yml 配置 > 环境变量 > `~/.visionpower/config.json`**。API Key 建议继续放在 `~/.visionpower/config.json`（mode 600），不写进 cordis.yml。

## 工具参数（与 MCP 形态一致）

`image_path` / `image_url` / `image_base64` / `image_ref` / `images[]` / `image_mime_type` / `prompt` / `output_format`，语义与主 README「接口参考」完全一致。

**无扩展名文件**：dsh 会把拖入的图片以内容寻址方式存成无扩展名文件。`image_path` 可直接传这类路径——内核按 magic bytes 自动识别六种格式（JPEG/PNG/WEBP/GIF/BMP/TIFF），无需复制或加后缀；非空且未知的扩展名仍会被拒绝，有扩展名时内容与扩展名必须一致。

## ⚠️ 安装陷阱（重要）

插件对 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` 的依赖是**可选 peer 依赖**（`peerDependenciesMeta.optional`），普通 npm 安装不会把它们带进 profile。

dsh 启动时会把这些内置包从安装目录软链到 `$DSH_HOME/profiles/node_modules` 作为回退，插件的 peer import 自动解析到**与 harness 完全相同的副本**（保证内部 Symbol 一致）。

**不要**：

- 把这三个包手动装成 profile 直接依赖；
- 开启 `autoInstallPeers`。

否则 profile 内的副本会遮蔽该回退，导致工具调度器 Symbol 错位，所有工具调用报 `Cannot read properties of undefined (reading 'prepare')`。

## 开发（仓库根目录执行）

```bash
npm run build:dsh   # 重新生成 src/dsh/core.bundle.js（内核改动后必须执行）
npm run build:skill # 重新生成 Skill 脚本（内核改动后必须执行）
npm test            # 全量测试，含三形态同步校验
npm run lint        # 静态检查
```
