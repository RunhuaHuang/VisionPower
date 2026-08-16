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

1. 定位图片：**一条命令完成**（解析当前会话日志取最后一个 image 附件 → 算出内容寻址路径 → 验证存在并打印绝对路径；拖拽和直接粘贴都会产生 image 块，流程完全相同）：
   AID=$(unzstd -c "$DSH_SESSION_JSONL" | python3 -c "
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
   ")
   HEX=\${AID#sha256:}; P="$DSH_HOME/attachments/v1/objects/\${HEX:0:2}/$HEX"
   ls "$P" >/dev/null 2>&1 && echo "$P"
   - 打印出一个绝对路径即成功，直接进第 2 步，**不要再 ls/echo/分步确认**。
   - 输出为空或报错才排查：
     - 必须读 $DSH_SESSION_JSONL（当前会话自己的日志，dsh 已注入 shell）；未设置时用
       find ~/.dsh/sessions -name 'session.jsonl.zstd' -type f -print0 | xargs -0 ls -t 2>/dev/null | head -1
       并校验该日志最后一条 user/message 文本与当前消息对得上；对不上换次新日志重试。
     - 不要用 grep sha256: 之类的文本匹配——agent 自己的工具输出会把历史 sha256 写进日志，grep 会误判。
     - 仍查不到 → 兜底：find "$DSH_HOME/attachments/v1/objects" -type f ! -name '.DS_Store' -exec ls -lt {} + | head
       （取 mtime 最新；注意重复拖/贴同一张图会被内容寻址去重、mtime 不刷新，此时必须回到日志法）。
   - image 块带 name 字段：拖拽保留原始文件名；直接粘贴（Cmd/Ctrl+V）固定为 image.png——落盘与识别完全一样。
2. 识图：**直接调 describe_image**（image_path / image_url / image_base64 / image_ref / images[]）——文件名是 sha256、无扩展名是正常的，内核按 magic bytes 自动识别六种格式（JPEG/PNG/WEBP/GIF/BMP/TIFF）；报 not a supported raster image 时用 file <路径> 排查。**不要先试 dsh 内置的 read_image**——它把图片原件交给模型、要求模型本身接受图片输入，纯文本路由下必然失败，也不接受无扩展名路径；read_image 只在第 0 步上半分支（多模态路由）才有意义。
3. 回复风格：定位与识图都是**内部步骤**——连续调用工具，**不要在工具调用之间输出面向用户的解说**（如「让我看看」「找到了附件」「文件存在」等）；拿到识图结果后一次性答复用户。消息文本里直接给出了图片路径时，优先用它，跳过第 1 步。`
