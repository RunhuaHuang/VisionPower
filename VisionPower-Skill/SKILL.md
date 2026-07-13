---
name: visionpower
description: Understand images — read screenshot text (OCR), interpret charts and diagrams, and describe photos, UI mockups, or document scans using a vision model. Use whenever the user shares or points to an image, screenshot, photo, chart, diagram, or asks "what's in this picture", "read the text in this image", or to analyze visual content. Runs the bundled describe_image.mjs script (Node 18+) and needs a vision model API key.
---

# VisionPower

Understand one or more images with a vision model. This skill is **self-contained**:
the script `describe_image.mjs` sits next to this file and runs with plain Node.js —
no `npm install`, no CLI to install, no extra dependencies. It only needs **Node 18+**
and a vision model **API key**.

Call the script by its absolute path. If this skill is installed at
`~/.claude/skills/visionpower/`, the script is
`~/.claude/skills/visionpower/describe_image.mjs`.

## Response style (important)

Keep the mechanics invisible. The user wants the answer about their image, not a
play-by-play of how you got it.

- **Do not narrate or pre-check on normal calls.** Do not run `node --version`, do not
  `cat` the config file, and do not announce "checking environment", "config exists",
  "running the script", etc. Just run the script once and answer. First-time setup is the
  only exception.
- **Run the script directly.** Assume it is already set up. The script fails fast with a
  clear message if Node or the API key is missing — only THEN fall back to setup.
- **Remember verified setup.** The script writes a state marker at
  `~/.visionpower/skill-state.json` after any successful model call. If that marker says
  `"configVerified": true`, never do setup/config preflight on later calls; only ask the
  user to reconfigure if a later script run fails with a missing-key/auth/config error.
- **Do not expose internals** in your reply: no command lines, no absolute paths, no raw
  request JSON, no model/config details. Present only the result (or a brief, plain-language
  error if it failed).
- Reply in the **user's language**, concise and direct — as if you simply looked at the image.

## First-time setup (only when not configured)

**Skip this on normal calls.** Only do it the very first time, or after the script returns
a missing-key, authentication, or configuration error. The settings are saved to a
**persistent config file** `~/.visionpower/config.json` that the script reads automatically
on every run, so the key survives across sessions and you never configure it again.

The script also maintains a **setup-state marker**:

```json
{ "configVerified": true, "verifiedAt": "..." }
```

This lives at `~/.visionpower/skill-state.json` (override with
`VISIONPOWER_SKILL_STATE`). A successful analysis or verification writes
`configVerified: true` automatically. Missing-key/auth failures write
`configVerified: false` best-effort. Use this marker only to avoid repeated setup checks;
do not read or print the API key.

1. **Confirm Node 18+** (only here, not on normal calls): `node --version`.

2. **Ask the user which vision model to use**, and offer the default:
   - `qwen3-vl-flash` — **default**, Alibaba Cloud Model Studio / DashScope, fast & low-cost.
     Get a key: https://bailian.console.aliyun.com/?tab=model#/api-key
   - `qwen3-vl-plus` — DashScope, higher quality.
   - `gpt-4o` — OpenAI (set `baseUrl` to `https://api.openai.com/v1`).
     Get a key: https://platform.openai.com/api-keys

   If the user has no preference, use `qwen3-vl-flash`.

3. **Ask the user for their API key, then save it** to the persistent config file. Create
   `~/.visionpower/config.json` (mode 600). Only include `model`/`baseUrl` if not the default:

   ```bash
   mkdir -p ~/.visionpower
   cat > ~/.visionpower/config.json <<'JSON'
   {
     "apiKey": "PASTE_THE_KEY_HERE",
     "model": "qwen3-vl-flash"
   }
   JSON
   chmod 600 ~/.visionpower/config.json
   ```

   For OpenAI, add `"baseUrl": "https://api.openai.com/v1"` and set `"model": "gpt-4o"`.
   Never print the key back to the user — only confirm it was saved.

4. **Verify**: run `node <skill>/describe_image.mjs --image-url <some public image> --prompt "describe"`.
   It should now reach the model instead of reporting a missing key. A successful run records
   `configVerified: true`, so future calls should go straight to image analysis with no
   config check.

> The script also accepts the API key from the `VISIONPOWER_API_KEY` environment variable,
> which overrides the config file. The config file is the recommended way because an agent's
> spawned shell usually does **not** inherit env vars you exported in your shell profile.

## How to use

On a normal request, **just run the script once** with the image and report the result —
no preflight checks, no narration (see Response style above). Pick the simplest form below
and replace `<skill>` with this folder's absolute path.

### A single local image (use an absolute path)

```bash
node <skill>/describe_image.mjs --image-path /absolute/path/to/image.png --prompt "Read the text and summarize it."
```

### A public image URL

```bash
node <skill>/describe_image.mjs --image-url https://example.com/image.png --prompt "What is in this image?"
```

### Multiple images, Base64, or any complex request — use JSON

Write the request to a file and pass it as an argument (or pipe it via stdin):

```bash
node <skill>/describe_image.mjs /tmp/visionpower-request.json
# or
cat /tmp/visionpower-request.json | node <skill>/describe_image.mjs
```

Request shape:

```json
{
  "images": [
    { "image_path": "/absolute/path/to/first.png" },
    { "image_url": "https://example.com/second.jpg" }
  ],
  "prompt": "Read each image in order and summarize."
}
```

## Output

The script prints the model's answer to stdout. On failure it prints
`VisionPower error: <reason>` to stderr and exits non-zero — read the reason and fix the
input (for example: use an absolute path, use a publicly reachable URL, or run first-time
setup to configure the API key).

## Rules

- `image_path` must be an **absolute** path on the machine running the script.
- `image_url` must be **publicly reachable**; local/private addresses are rejected.
- Provide exactly **one** source per image: `image_path` OR `image_url` OR `image_base64`.
- Do not combine top-level image fields with `images[]`.

## Configuration reference

Settings come from `~/.visionpower/config.json` (override the path with `VISIONPOWER_CONFIG`).
Matching `VISIONPOWER_*` environment variables override the file.

| config.json key | env override | Default | Purpose |
| --- | --- | --- | --- |
| `apiKey` | `VISIONPOWER_API_KEY` | — | API key for the vision provider |
| `model` | `VISIONPOWER_MODEL` | `qwen3-vl-flash` | Vision model name |
| `baseUrl` | `VISIONPOWER_BASE_URL` | DashScope `/compatible-mode/v1` | OpenAI-compatible base URL |
| `maxImages` | `VISIONPOWER_MAX_IMAGES` | `8` | Max images per call |
| `timeoutMs` | `VISIONPOWER_TIMEOUT_MS` | `60000` | Upstream timeout (ms) |
| `cache.enabled` | `VISIONPOWER_CACHE` | `true` | In-process result cache for byte-identical local/Base64 images; public URLs are not cached |
| — | `VISIONPOWER_CACHE_MAX_ENTRIES` | `32` | Result cache capacity (0 disables) |
| — | `VISIONPOWER_CACHE_TTL_MS` | `1800000` | Result cache entry lifetime (ms) |
| — | `VISIONPOWER_SKILL_STATE` | `~/.visionpower/skill-state.json` | Verified setup marker path |
