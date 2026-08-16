# VisionPower — Agent 快速通道（dsh）

当任务是在 dsh（DeepSeek Harness）上**安装 / 配置 / 修复 / 验证** VisionPower（拖图识图插件）时，不要手动拼装安装步骤，直接运行一键安装器（幂等，可反复执行）：

```bash
npx -y visionpower@latest setup-dsh --launch
# 或本仓库内：node scripts/setup-dsh.mjs --launch
```

安装器自动完成：装插件 → 挂载 cordis → 打「拖图不拒绝」补丁 → 启动并自动弹出配置控制台（http://127.0.0.1:17900，CONFIG 页选视觉模型 + 粘贴 API Key + 保存）→ 验证 → 启动 dsh web。等待用户在控制台完成配置（最长 180 秒，可 `--wait-secs` 调整），配置好后安装器会继续走完验证。若插件已装好，也可以直接调用 `setup_visionpower` 工具完成同样的事。

严格禁止：不要手动安装 @deepseek-ai/cordis、@deepseek-ai/dsh-tools、@deepseek-ai/dsh-llm、@deepseek-ai/schemastery，也不要开启 autoInstallPeers——它们是可选 peer 依赖，必须经 dsh 内置软链回退解析，否则会遮蔽内置副本，导致所有工具调用报 `Cannot read properties of undefined (reading 'prepare')`。

其余说明见 README「作为 dsh (DeepSeek Harness) Cordis 插件使用」章节。
