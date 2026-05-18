# WebAdapterTools

Static page profiler for AI-assisted WebAI2API adapter generation.

The first version only collects page information. It does not submit forms, upload files, automate login, solve captchas, or store response bodies.

## Install

```bash
pnpm install
```

## Collect A Page Profile

```bash
pnpm collect <url> --out <dir>
```

Examples:

```bash
pnpm collect https://example.com/app --out captures/example
pnpm collect https://example.com/app --out captures/private --interactive --user-data-dir profiles/example
pnpm collect https://example.com/app --out captures/example --headless --timeout 60000
pnpm collect https://example.com/app --out captures/action --record-action --user-data-dir profiles/example
pnpm collect https://example.com/app --out captures/example --window-size 1366x768
```

The headed Camoufox window is fixed to `1280x720` by default so the browser window and page layout do not drift to a random fingerprint size. Use `--window-size WIDTHxHEIGHT` if the window does not fit your display or a page needs a larger layout.

If an existing profile still opens at an old size, pass a fresh `--user-data-dir` once or manually resize the browser window before pressing Enter in `--interactive` mode.

Outputs:

- `profile.json`: lightweight index for the capture bundle.
- `capture.json`: capture metadata and run options.
- `pages/current.json` or `pages/before.json` + `pages/after.json`: page summaries.
- `elements/current.json` or `elements/before.json` + `elements/after.json`: categorized DOM element inventories.
- `recommendations/current.json` or `recommendations/before.json` + `recommendations/after.json`: ranked input/upload/submit/output candidates.
- `network/initial.json`: initial page-load network summary.
- `network/action.json`: manual-action network summary when `--record-action` is used.
- `actions/events.json`: safe user action event metadata when `--record-action` is used.
- `actions/diff.json`: before/after DOM diff when `--record-action` is used.
- `interface.json` + `interface.md`: generated interface plan after running `pnpm analyze`.
- `profile.html`: offline human review report.

## Analyze A Capture Into An Interface Plan

```bash
pnpm analyze <capture-dir>
```

Examples:

```bash
pnpm analyze captures/action
pnpm analyze captures/action --out captures/action/interface
```

The analyzer reads `profile.json` and the referenced page, recommendation, action event, DOM diff, and network files. It writes:

- `interface.json`: machine-readable browser automation interface plan with inferred inputs, submit action, output extraction, replay steps, confidence, warnings, and network endpoint candidates.
- `interface.md`: short human-readable review summary.

The generated interface plan is intentionally conservative. Because the network recorder does not store headers, request bodies, response bodies, cookies, or query values, the analyzer does not claim to reproduce private HTTP APIs. It ranks sanitized network candidates as evidence and generates a browser-driven adapter plan from selectors and recorded user action metadata.

## Login State

Use `--interactive --user-data-dir <dir>` for pages that require login. Complete login or navigation manually in the opened browser, then press Enter in the terminal. The tool does not automate login.

## Captured Data

The JSON profile includes:

- capture metadata and final URL
- page title, language, text statistics, and basic counts
- interactive element summaries
- recommended input, upload, submit, and output candidates
- initial network summary with method, origin, path, query keys, resource type, status, and failure text

Network headers, request bodies, response bodies, cookies, and query values are not captured.

## Manual Action Capture

Use `--record-action` when static profiling is not enough. The CLI pauses after navigation so you can prepare the page, captures a before snapshot, then asks you to manually perform exactly one target action, such as typing a test prompt and submitting it. It records before/after DOM differences and network metadata for that manual action.

The tool also records safe browser-side action metadata: clicks, text input length/preview for non-sensitive fields, file names/types/sizes, submit events, and selected key presses. Password/auth/captcha-like inputs are redacted. The tool still does not click, submit, upload, log in, or solve captchas by itself.

Typical workflow:

```bash
pnpm collect https://example.com/app --out captures/action --record-action --user-data-dir profiles/example
pnpm analyze captures/action
```
