# Changelog

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
