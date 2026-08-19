# Changelog

## Unreleased

## 3.1.0 - 2026-08-19

- Updated the dsh/Cordis integration baseline to DeepSeek Harness
  `0.1.0-rc.7`. Dragged and pasted images are now read through the host's
  durable `AttachmentStore` in message order; VisionPower no longer parses
  attachment IDs, decompresses session logs, or derives private storage paths.
- Added a native **Settings → Plugins → VisionPower** browser tab. It embeds
  the loopback-only VisionPower configuration console, sharing the same
  `~/.visionpower/config.json`, model presets, API-key storage, connection test,
  and save flow used by MCP and the standalone WebUI.
- Added a default-on, dsh-only VisionPower switch to that tab. Saving a disabled
  state stops dsh image-rule injection and makes dsh `describe_image` reject new
  requests; MCP, Skill, and the standalone WebUI remain available. Re-enabling
  takes effect without restarting dsh. The UI now makes clear that **Save and
  apply configuration** persists changes automatically.
- The dsh switch now saves and applies immediately when toggled, through a
  dedicated one-field endpoint that cannot commit unrelated unsaved model or
  API-key edits. Failed updates reconcile the checkbox back to server state.
- Extended the dsh compatibility patch for rc.7's `onReplayDegrade` pi-ai
  context conversion while retaining rc.6 matching and self-tests.
- Hardened the rc.7 integration after review: disabled and over-count
  attachment requests now fail before attachment reads/Base64 allocation;
  Settings owns the live enable switch instead of Cordis composition
  overrides; legacy rc.6 AGENTS rules are migrated through a versioned block;
  truncated SSE responses retry within the provider-submission budget; and the
  embedded console verifies its loopback instance, version, configuration path,
  parent origin, and iframe handshake before reuse.
- Embedded Settings status reflects the server-applied dsh enable state while
  the standalone Playground remains available. Changing the checkbox remains a
  draft until **Save and apply configuration** succeeds.
- Hardened the whole surface in a review-driven pass: the welfare gateway
  endpoint is stored and shipped only as XOR+Base64 ciphertext (no plaintext
  in the repo, bundles, or any webui response); the connection test proves
  real vision capability with a random four-digit challenge PNG and reports
  `visionVerified`/`reason`; SSE parsing handles standard multi-line `data:`
  events and comments no longer unlock the first-byte watchdog; and the disk
  result cache refreshes recency through the already-verified file descriptor,
  closing a TOCTOU window.
- dsh tool requests gained strict current-turn attachment semantics with an
  explicit `attachment_scope="latest_in_session"` opt-in for reusing a
  previously sent image; the routing parameter is stripped before core
  validation, which previously rejected every documented use of it.
- The `image_url` download path now fails over sequentially across the
  verified address set, uses the array-form DNS lookup callback (the legacy
  triple form throws `ERR_INVALID_IP_ADDRESS` on Node 20+ happy-eyeballs),
  and accepts public IPv6 literals.
- `patch-dsh.mjs` writes are transactional — temp+rename with full rollback on
  any structure or syntax failure, never leaving a half-patched install — and
  `setup-dsh --check` reports missing patches instead of false-passing after a
  dsh upgrade; spawned console/dsh-web processes carry error handlers and the
  Windows `.cmd` launch path survives spaces in the install path.
- The `setup_visionpower` installer runner bounds captured output, kills the
  whole installer process group on timeout/cancel, and always waits for child
  close; `PUT /api/config` preserves persisted keys unknown to this version;
  CI now also runs the full matrix on macOS.

## 3.0.1 - 2026-08-16

Acceptance-review fixes (three parallel reviewers over the full dsh
suite):
- setup_visionpower no longer blocks the host: spawnSync (which froze
  the dsh web event loop for up to 5 minutes, uncancellable) became an
  async spawn that collects output, honors the abort signal, enforces a
  300s kill timer, and reports timeout/abort/error distinctly.
- setup-dsh --check is now genuinely read-only: patch-dsh gained
  --dry-run (probe and report without writing), and the check path uses
  it - previously a fresh/changed dsh install would get patched "while
  only checking", contradicting the documented contract.
- The config console now waits for port 17900 to actually listen before
  opening the browser (fresh spawns up to 30s), and --console opens it
  even when an API key already exists.
- The injected rules' session-log fallback now respects
  $DSH_HOME instead of hardcoding ~/.dsh/sessions.
- Docs: injectRules described as per-turn (stale - it is per
  image-relevant turn), README.en "Turn either off" leftover, installer
  closing message still describing the removed auto-describe, missing
  protocol row and setup_visionpower mention in src/dsh/README.md,
  cordis.patch.yml naming, and four broken MCP anchor links.
- Tests: compareVersions and the cordis content transformation are now
  unit-tested, and patch-dsh --self-test runs as part of npm test so
  dsh structure drift surfaces in CI instead of at user install time.

## 3.0.0 - 2026-08-16

Major: the complete dsh (DeepSeek Harness) image-understanding suite,
iterated live on main as 2.9.0-2.9.11 (never published to npm) and
hardened by from-scratch install tests against dsh 0.1.0-rc.6. Ships
the `visionpower setup-dsh` one-command installer (idempotent, state
tracked, auto re-patch after dsh upgrades, model-agnostic image
admission), the native cordis plugin (describe_image as a plain tool +
image-locating rules injected on image-relevant turns, with a
battle-tested rule text covering drag-and-drop and paste), the
`setup_visionpower` agent tool, the repo-root AGENTS.md quick path for
one-sentence installs, and docs in Chinese and English.

## 2.9.11 - 2026-08-16

- One natural sentence to dsh now installs everything ("请你帮我按照
  GitHub 项目 RunhuaHuang/visionpower，完成 DeepSeek Harness 版
  VisionPower 插件的配置" - any reasonable phrasing). Three layers make
  it work: a repo-root `AGENTS.md` quick path (dsh auto-loads workspace
  AGENTS.md, so an agent that clones the repo immediately knows to run
  the installer), a new `setup_visionpower` tool registered by the
  plugin (post-install, any "configure / fix / check VisionPower"
  phrasing maps straight to a tool call instead of README
  re-derivation; it runs scripts/setup-dsh.mjs in an isolated child
  process with a short 20s API-key wait and returns the full report for
  the agent to relay), and the installer now pops the config console
  into the browser when the API key is still missing (it used to only
  spawn the server and print the URL).

## 2.9.10 - 2026-08-16

- Removed the multimodal-route detection introduced in 2.9.9: rules now
  inject on every image-relevant turn regardless of the route's model.
  A live session exposed that `agent.options` (provider/model) is
  captured when the agent is created and is NOT updated when the user
  switches models mid-session - so after switching from a multimodal to
  a text-only model the stale check kept skipping injection and the
  image went unhandled. Always injecting is strictly safer; the rules'
  own step 0 already steers genuinely multimodal models to answer
  directly from the image, so the cost is mild redundancy at most.

## 2.9.9 - 2026-08-16

- Rules injection is now scoped to where it matters. It fires only on
  image-relevant turns (a message carries image blocks, the user text
  mentions 图/截图/照片/screenshot/image, or the user text is empty -
  the pure-image shape), instead of every turn, so ~1.5KB of rules no
  longer accumulate into the history of purely textual conversations.
- When the current route runs a multimodal model, the rules are skipped
  entirely: the agent's provider/model is read from `agent.options` and
  modality resolved via the dsh `llm` service's `resolveModelInfo`; an
  `inputModalities` containing "image" means the model sees images
  natively and needs no locating pipeline. Any detection failure
  (missing service, unknown model, undeclared modalities) conservatively
  falls back to injecting - the rules' own step 0 already steers
  multimodal models to answer directly from the image.

## 2.9.8 - 2026-08-16

- Prompt-only fixes after another live round. The rules now open with a
  self-identification note - "injected by the VisionPower plugin, a
  working guide for the assistant, NOT a user utterance; there is no
  hidden actual request, do not explore the workspace looking for one" -
  which targets the 1500+ character deliberation spiral where the model,
  seeing only injected blocks on a text-only route, kept re-deciding
  whether the turn contained a real request. The read_image ban moved to
  the top trigger section and now also forbids post-success
  "double-check" image calls (live logs showed the model calling
  read_image AFTER describe_image had already returned a description);
  the step-2 mention became a cross-reference to keep the text lean.

## 2.9.7 - 2026-08-16

- Tightened the injected rules for a quieter transcript: locating the
  image is now ONE bash command (parse the session log for the last
  image attachment, derive the content-addressed path, verify it exists,
  print the absolute path) instead of the three separate probe/parse/ls
  calls agents were making, with a hard "don't re-confirm in extra
  steps" note. A new reply-style rule marks locating and describing as
  internal steps: fire the tool calls back-to-back with no user-facing
  narration in between ("let me check", "found the attachment", ...) and
  answer once at the end.

## 2.9.6 - 2026-08-16

- The injected rules now explicitly steer the agent away from dsh's
  built-in `read_image` tool on text-only routes: it hands the image
  itself to the model (requiring an image-capable route) and only
  accepts extensioned PNG/JPEG/WebP/GIF paths, so on a text-only route
  it fails 100% of the time - and dsh's content-addressed attachments
  have no extension anyway. Live logs showed the agent trying read_image
  first and wasting a step before falling back to describe_image.

## 2.9.5 - 2026-08-16

- Removed the pre-turn auto-describe machinery entirely: describe_image is
  now a plain tool the agent calls during its normal tool-calling phase.
  Live testing showed the blocking design was structurally at odds with
  dsh's rendering - the turn's messages (including the user's own image)
  only materialize when step 1 starts, so waiting for a vision result
  before composing step 1 rendered as dead air with the sent image
  invisible, at any wait cap. The normal tool flow has visible progress,
  exactly one vision call per image, and no stall; the injected rules
  (which already carry a positive action for textless image sends) drive
  the agent to locate and describe the image on its own. Dropped the
  `autoDescribe` / `autoDescribeWaitMs` config keys, the session-event
  staging, and the `attachments` service injection; docs updated
  accordingly.

## 2.9.4 - 2026-08-16

- First live end-to-end run surfaced two UX problems, both fixed. The
  turn now shows at most ONE VisionPower injection: when auto-describe
  succeeds only the description is injected (the locating rules are
  redundant - the agent no longer needs to find the image); on
  error/timeout the rules are merged into that same fallback message
  instead of a second one; with no image the rules inject as before.
- The dead-air wait dropped sharply: the auto-describe prompt now asks
  for a concise <=150-char summary (output length dominates vision
  latency; details remain one describe_image call away), and the wait
  cap fell from timeoutMs+5s to a new `autoDescribeWaitMs` (default
  15s, never above timeoutMs) - on timeout the turn proceeds
  immediately via the rules route instead of stalling silently.

## 2.9.3 — 2026-08-16

- Fixed the last auto-describe link: staged descriptions were keyed by
  `session.id` but consumed under `agent.sessionId`, which is `undefined`
  in dsh 0.1.0-rc.6 (the real field is `agent.id`) — so the pending task
  was never found and nothing was ever injected, even after the listener
  fixes. Consumption now uses `agent.id ?? agent.sessionId ?? 'default'`,
  and staging/injection emit debug log lines when `debug: true`.
- setup-dsh is now a genuinely one-command-fits-all re-run: with an API
  key already configured it no longer spawns the config console (new
  `--console` flag forces it for vision-model changes), and the closing
  summary states the model story explicitly — the image-accept patch is
  model-agnostic, so newly added or swapped text-only models in dsh need
  nothing and are covered automatically; re-running the same command
  re-verifies the pipeline (superseding the old
  `curl … patch-dsh.mjs && node …` flow).

## 2.9.2 — 2026-08-16

- Fixed auto-describe still not firing in the web host: session events are
  dispatched with a per-session carrier as `thisArg`, and the carrier's
  scope filter dropped the plugin's non-global listener (the headless host
  has no such filter, which is why the earlier probe passed). The
  `session/event` listener is now registered with `{ global: true }`.
- Image-only messages no longer bounce back as "what do you want me to
  do?": on a text-only route the dropped image leaves the turn with no
  user-visible input at all, and the model mistook the injected
  instructions for the user's message. The auto-describe injection now
  carries a positive instruction for textless sends ("summarize the image
  content directly, do not ask back"), the error/timeout fallback notices
  tell the agent to describe it to the user, and the injected rules'
  empty-message guidance changed from a prohibition ("don't reply 'got
  nothing'") to an action ("locate the image, describe it, tell the
  user").

## 2.9.1 — 2026-08-16

- Fixed auto-describe never firing: the plugin staged vision runs from the
  `user/message` session event, but that event only lands in the session
  log **after** the turn's first `agent/pre-step` has already run — the
  only injection point — so no description was ever injected (images were
  still handled via the injected-rules fallback, at the cost of extra
  agent steps). Staging now listens to `agent/inbox/spliced`, which
  carries the same image blocks before the turn starts, letting the
  vision call race the turn and the description reach step 1. Verified
  against dsh 0.1.0-rc.6 by probing both hosts' event ordering.

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
- Fixed two setup-dsh bugs caught by a from-scratch install test: the
  direct-run guard silently skipped `main()` when the script was invoked
  through a symlinked path (macOS `/tmp` vs `/private/tmp` - both sides
  are now realpath-normalized), and mounting cordis appended the insert
  block after dsh's default bare `[]` line, which is invalid YAML and
  broke the whole profile overlay (the bare empty-array line is now
  stripped before appending). patch-dsh's stale "AGENTS.md missing"
  warning became an informational note now that rules are injected at
  runtime by default.
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
