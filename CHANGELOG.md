# Changelog

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
