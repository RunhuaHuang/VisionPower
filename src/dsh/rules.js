// Canonical VisionPower image-locating rules for text-only (non-multimodal)
// model routes. This is the single source of truth for the rules text:
//
//  - the dsh plugin injects it into the agent context via `agent/pre-step`
//    (Route A, default), and
//  - `setup-dsh --write-agents` appends the same text to ~/.dsh/AGENTS.md
//    for users who prefer visible/editable rules (Route B).
//
// Keep the two delivery paths in sync: they both read this module.

export const RULES_MARKER = '何时触发查图'

export const RULES_TEXT = `# 图片的定位与识图规则（VisionPower）

## 0. 先判断模型是否多模态（最重要）
- 消息里能直接看到图片内容 → 多模态模型 → 直接看图回答；不要走下面的磁盘流程。
- 看不到图片内容（纯文本路由，图片块被丢弃）→ 按第 1–3 步定位文件并调 describe_image。

## 非多模态模型的定位与识图

【何时触发查图（先判断要不要查，再查）】
- 用户消息文本为空/看似「没发内容」→ 这几乎总是「只发了一张图」（纯图片消息，图片块在纯文本线路上被丢弃）：按第 1 步查日志定位图片并识图，把内容总结直接告诉用户；不要回复「没收到」，也不要反问用户想做什么。
- 文本里提到 图/图片/截图/照片/screenshot 等关键词。
- 上下文暗示有附件（如刚讨论过某张图、用户说「再发一张」）。

1. 取 attachmentId（首选当前会话日志，精确；拖拽和直接粘贴都会产生 image 块，流程完全相同）：
   unzstd -c "$DSH_SESSION_JSONL" | python3 -c "
   import sys, json
   last = None
   for line in sys.stdin:
       try: ev = json.loads(line)
       except: continue
       if ev.get('type') == 'user/message':
           for b in ev.get('data', {}).get('content', []):
               if b.get('type') == 'image':
                   last = b.get('attachment', {}).get('attachmentId')
   print(last or '')
   "
   - 必须读 $DSH_SESSION_JSONL（当前会话自己的日志，dsh 已注入 shell）；未设置时用
     find ~/.dsh/sessions -name 'session.jsonl.zstd' -type f -print0 | xargs -0 ls -t 2>/dev/null | head -1
     并校验该日志最后一条 user/message 文本包含当前消息的关键词；对不上换次新日志重试。
   - 不要用 grep sha256: 之类的文本匹配——agent 自己的工具输出会把历史 sha256 写进日志，grep 会误判。
   - image 块带 name 字段：拖拽保留原始文件名；直接粘贴（Cmd/Ctrl+V）固定为 image.png——两种方式落盘位置与流程完全一样。
2. 图片路径 = $DSH_HOME/attachments/v1/objects/<attachmentId 去掉 sha256: 前缀后的前 2 位>/<完整 hex>。
   - 查不到/为空 → 兜底：取 objects 下 mtime 最新的普通文件（排除 .DS_Store）。
   - 重复拖/贴同一张图会被内容寻址去重（无新文件、不刷新 mtime），此时 mtime 兜底会指错，必须回到日志法。
3. 识图：**直接调 describe_image**（image_path / image_url / image_base64 / image_ref / images[]）——文件名是 sha256、无扩展名是正常的，内核按 magic bytes 自动识别六种格式（JPEG/PNG/WEBP/GIF/BMP/TIFF）；报 not a supported raster image 时用 file <路径> 排查。**不要先试 dsh 内置的 read_image**——它把图片原件交给模型、要求模型本身接受图片输入，纯文本路由下必然失败，也不接受无扩展名路径；read_image 只在第 0 步上半分支（多模态路由）才有意义。消息文本里直接给出了图片路径时，优先用它，跳过第 1–2 步。`
