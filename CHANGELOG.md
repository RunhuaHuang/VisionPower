# Changelog

## 2.9.0 — 2026-08-16

- Added `visionpower setup-dsh` (also `node scripts/setup-dsh.mjs`): a
  one-command, idempotent installer for dsh that chains plugin install
  (prefer `dsh plugin add`, fall back to pnpm; version-aware skip/upgrade)
  -> cordis mount -> patch-dsh application with state tracking
  (`~/.dsh/.visionpower-state.json` records the dsh version and target
  file hashes, so re-running after a dsh upgrade/npx reinstall re-patches
  automatically) -> optional rules write (`--write-agents`) -> config
  console (background spawn, waits for the API key) -> verification ->
  optional `--launch` of dsh web with browser open. `--check` verifies
  everything without changing anything. Cross-platform (Windows .cmd
  shims handled); the pnpm bootstrap now falls through corepack to
  `npm install -g pnpm`, so Node 25+ (which ships no corepack) no longer
  dead-ends.
- The dsh plugin gained two zero-effort behaviours for text-only model
  routes, both default-on and individually disableable in the plugin
  `config`:
  - `autoDescribe`: on user messages carrying image blocks (drag-and-drop
    and paste share the same pipeline), the plugin reads the attachment
    bytes, runs the vision core, and injects the description into the
    next turn via `agent/pre-step` - the user never has to mention the
    image. Per-session dedup, supersede-abort, a timeout cap with
    graceful degradation to the rules fallback, and composition failures
    that never break the agent turn.
  - `injectRules`: the canonical image-locating rules are injected into
    the agent context on the first step of every turn, skipped when
    identical rules are already present (context or `~/.dsh/AGENTS.md`).
- New `src/dsh/rules.js` is the single source of truth for the rules
  text, shared by the runtime injection (Route A, default) and
  `setup-dsh --write-agents` (Route B, visible/editable in
  `~/.dsh/AGENTS.md`). `@deepseek-ai/dsh-llm` joins the optional peer
  dependencies (resolved via dsh's built-in symlink fallback).
- Rewrote the dsh install docs around the one-liner: the guided agent
  prompt is now a thin fallback that runs setup-dsh instead of manual
  steps; documented the plugin flags (`autoDescribe`, `injectRules`) and
  the npm-registry `--plugin-source` for slow networks; added the dsh
  section (one-liner + fallback prompt + install trap) to README.en.md;
  `src/dsh/README.md` gains the drag/paste pipeline section.
- Version bumped to 2.9.0: existing 2.8.0 installs would otherwise be
  wrongly skipped as "same version" by the installer's upgrade check,
  and npm does not allow republishing a version.

## 2.8.0 — 2026-08-14

- Provider requests are now sent streamed (`stream: true`) and aggregated
  internally into the complete answer — callers see no behavior change. A
  new first-byte watchdog (default 15s, config `firstByteTimeoutMs` / env
  `VISIONPOWER_FIRST_BYTE_TIMEOUT_MS`, capped at `timeoutMs`) aborts and
  retries early when an upstream accepts the request but stalls before its
  first token, instead of idling to the full request timeout. Gateways that
  ignore the `stream` flag (plain JSON answers) or reject it outright
  (automatic non-streaming retry) are both handled.
- Added a cross-process on-disk result cache (default `~/.visionpower/cache`,
  env `VISIONPOWER_CACHE_DIR`). The in-memory cache dies with the process, so
  short-lived Skill runs never shared results; the disk mirror reuses recent
  identical image+prompt requests across processes under the same
  TTL/entry-budget knobs, with owner-only files.
- Raised the default `maxTokens` from 2048 to 4096: long OCR answers were
  regularly truncated, forcing agents to re-run the whole call. Configs saved
  by an older WebUI (which persisted the then-default 2048 explicitly) still
  count as "no explicit user budget", so provider-recommended budgets (e.g.
  Kimi's 32768) keep applying to the connection probe and preset switching.
- Tool descriptions and the Skill guide now steer agents toward focused
  prompts ("Read the error message text") over open-ended "describe
  everything" requests — output length is the dominant per-call latency
  factor.
- The WebUI gained a "First-Byte Timeout" setting and no longer exposes the
  server-side cache directory through `GET /api/config`.

## 2.7.2 — 2026-08-14

- Added Anthropic Messages API protocol support for custom model presets. Users
  can now select between OpenAI-compatible and Anthropic protocols in the WebUI;
  built-in presets continue to use the OpenAI protocol by default.
- Added a `protocol` config field (env: `VISIONPOWER_PROTOCOL`, file: `protocol`)
  accepted values: `openai` (default) or `anthropic`.
- The Anthropic adapter converts OpenAI-formatted message payloads to the
  Messages API shape on the wire: `/messages` endpoint, `x-api-key` and
  `anthropic-version` headers, top-level `system` field, and base64 image sources.
- Switching to "Custom Model Preset" no longer carries over the previous
  preset's Base URL; the field starts empty for the user's own endpoint.
- The Anthropic Base URL accepts the bare official host
  (`https://api.anthropic.com`): the required `/v1` path segment is filled in
  automatically when the request URL is built, so the stored/displayed value
  stays exactly what the user typed. Custom gateways keep whatever path the
  user configures, and the credential-scope checks treat the bare host and its
  `/v1` form as the same endpoint.
- The dsh (DeepSeek Harness) plugin now re-derives the protocol after a
  `model`/`baseUrl` override (an explicit `protocol` option was added too), so
  an overridden Anthropic endpoint is never sent an OpenAI-shaped request.
- A connection test whose Anthropic reply contains only hidden thinking blocks
  (token budget exhausted by reasoning) now counts as verified instead of
  failing with "no text content".

## 2.7.1 — 2026-08-14

- Updated the welfare preset's Base URL placeholder copy in the WebUI to make
  it clear the built-in channel needs no user modification.

## 2.7.0 — 2026-08-14

- Hid the private welfare gateway endpoint everywhere the browser can see:
  the WebUI and its API exchange only the opaque `builtin:welfare` alias, and
  the server resolves the alias back to the real endpoint for validation,
  persistence, and connection probes. The endpoint itself is stored as an
  XOR+Base64 cipher in the published source instead of plaintext, and the
  hostname in the capability registry is derived from that cipher.
- Restricted the welfare alias to the model the channel actually serves:
  requests pairing the alias with any model other than MiniMax-M3 are rejected
  with a clear error, so the private gateway cannot be reused for arbitrary
  models.
- Unified the WebUI's API-key preservation rules for `PUT /api/config` and
  `POST /api/test-connection` into one shared `resolveApiKeyChoice` helper so
  the two routes cannot drift, and fixed an indentation drift in the PUT
  handler.
- Hardened `readJsonBody`: oversized bodies now get the connection dropped
  shortly after the 413 response instead of letting a peer stream
  indefinitely.
- Simplified WebUI routing: the query string is stripped once per request and
  the pathname is shared by the static and API dispatch paths.
- Made `normalizeModelForKnownEndpoint` tolerate an unparsable Base URL
  instead of throwing a bare `TypeError`.
- Masked the welfare endpoint in the `PUT /api/config` response too — the
  resolved Base URL is persisted but never echoed back to the browser.
- Fixed a WebUI foot-gun where merely focusing/editing the API-key field
  (without changing its masked value) marked it dirty, which could persist the
  display mask as the real credential on save. The dirty flag now only trips
  when the value actually differs from the loaded mask.

## 2.6.1 — 2026-08-13

- Added `scripts/patch-dsh.mjs` (also shipped in the npm package): a
  cross-platform, idempotent patcher that removes DeepSeek Harness's
  server-side image rejection so text-only model routes admit image messages
  (images are dropped on the wire and recognition is delegated to the harness
  tool layer, e.g. this package's `describe_image`). Auto-discovers every dsh
  install, verifies syntax of touched files, self-tests its anchors, and fails
  loudly on version drift.

## 2.6.0 — 2026-08-13

- Added a native DeepSeek Harness (dsh) Cordis plugin, shipped as the
  `visionpower/dsh` subpath of the main package: a first-class `describe_image`
  tool with in-process execution, composition-level config overrides, and
  cooperative cancellation through the dsh tool-call signal.
- Accepted extensionless image paths — content-addressed agent attachments are
  identified purely by magic bytes across all six formats — while keeping the
  extension allowlist and the extension/content match check for named files.
- Threaded an optional AbortSignal through the core so callers can cancel
  upstream requests and retry backoff immediately instead of waiting for the
  request timeout.
- Built the dsh plugin core bundle from the canonical core sources through a
  shared bundling helper, and extended the test suite to keep the MCP server,
  the standalone Skill, and the dsh bundle in lockstep.
- Documented the dsh installation flow (including the guided agent prompt and
  the WebUI configuration console) in the main README and `src/dsh/README.md`.

## 2.5.0 — 2026-08-10

- Added a secure, short-lived Image Inbox in the local WebUI and the new
  `image_ref` input for MCP, the standalone Skill, multi-image calls, and the
  Playground API.
- Added provider/model capability routing so known models select their token
  parameter and system-role strategy before the first request, with narrow
  explicit-error fallbacks for custom or drifting OpenAI-compatible gateways.
- Hardened staged-image storage with owner-only permissions, opaque random
  handles, TTL cleanup, entry limits, no-follow reads, file-version checks, and
  SHA-256 integrity verification.
- Expanded unit, HTTP integration, security, compatibility, CI, dependency
  audit, cross-version, smoke, and package checks.
- Updated built-in model presets, MCP annotations, structured output support,
  response/body limits, total image limits, atomic writes, and bilingual docs.
- Hardened both CLIs with strict option parsing and bounded JSON/config input,
  refreshed live Inbox locks safely, and aligned current provider token fields.
- Closed trailing-dot localhost and non-public IPv6 URL-validation gaps, and
  blocked IPv4-compatible IPv6 loopback forms such as `::7f00:1`.
- Enforced Base64 size limits before normalization/decoding, avoided a
  full-image validation re-encode, and preserved conventional wrapped Base64
  within a bounded whitespace allowance.
- Validated replacement-style partial WebUI config saves against the defaults
  and model-endpoint inference used on the next load, preventing a saved config
  from immediately becoming invalid.
- Replaced API-key mask inference with explicit WebUI preservation intent so a
  legitimate key containing `*` can never be silently replaced by an old key.
- Prevented a persisted masked key from being saved against an endpoint that
  is only active through environment overrides; the full key is now required
  before changing its saved endpoint scope.
- Tightened stale temporary-file cleanup to target only the exact files created
  by VisionPower and never follow or remove lookalike symbolic links.
- Corrected MCP tool annotations to avoid claiming this open-world, Inbox-
  cleaning tool is read-only or idempotent, and added a Node 18.14.1 CI smoke
  check for the standalone Skill.
- Raised the installed MCP/WebUI runtime floor to Node 20.19 so its current,
  security-fixed HTTP transport has a truthful engine contract; the standalone
  zero-dependency Skill remains compatible with Node 18.14.1+.
- Blocked IPv6 transition prefixes (6to4 `2002::/16`, well-known NAT64
  `64:ff9b::/96`, and Teredo `2001::/32`) that can encode a private IPv4
  address and bypass the image_url SSRF filter.
- Stopped V8's `SyntaxError` message from echoing request/config file contents
  (such as a private key) back to the Skill's stderr when a non-JSON file is
  parsed, and opened Skill request files with `O_NOFOLLOW`.
- Returned a fixed internal-error message from the WebUI while logging the real
  error locally, and aligned Inbox orphan cleanup with the module's `lstat`
  convention.
