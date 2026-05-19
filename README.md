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
pnpm collect https://example.com/app --out captures/ai-action --ai-record-action --ai-goal "send a message and wait for the response" --ai-input "hello"
pnpm collect https://example.com/app --out captures/action --record-action --browser-controls --user-data-dir profiles/example
pnpm collect https://example.com/app --out captures/action --record-action --action-count 3 --user-data-dir profiles/example
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
- `actions/segments.json`: per-action segment index when multiple actions are recorded.
- `actions/segments/<action-id>/events.json`, `diff.json`, `network.json`: per-action logs when action recording is used.
- `actions/segments/<action-id>/controller.json`: AI controller log when `--ai-record-action` is used.
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

## Generate A WebAI2API Adapter

```bash
pnpm generate-adapter <capture-dir> --target <WebAI2API-dir> --id <adapter_id> [--model <model-id>] [--display-name <name>] [--worker-name <name>]
```

Example:

```bash
pnpm analyze captures/action
pnpm generate-adapter captures/action --target ../WebAI2API --id bing_search_text --model bing-search --display-name "Bing Search"
```

The first generator version targets browser-driven text adapters using the `search_text` template. It creates a thin adapter file under `WebAI2API/src/backend/adapter/` and expects the WebAI2API template runtime to perform the shared browser flow:

- open target URL
- fill the recorded text input with the OpenAI prompt
- submit with the recorded action
- wait for the recorded output region
- return extracted text

After generation, set a WebAI2API worker `type` to the generated adapter id, for example `type: bing_search_text`.

The command also prints a minimal worker config snippet that can be merged into `WebAI2API/data/config.yaml` or `WebAI2API/config.yaml`.

## Verify A Generated Adapter

```bash
pnpm verify-adapter <adapter_id> --prompt <text> [--target <WebAI2API-dir>] [--model <model-id>] [--headless] [--visual] [--visual-out <dir>]
```

Examples:

```bash
pnpm verify-adapter bing_search_text --prompt "test" --target ../WebAI2API
pnpm verify-adapter bing_search_text --prompt "test" --target ../WebAI2API --headless --timeout 60000
pnpm verify-adapter bing_search_text --prompt "test" --target ../WebAI2API --visual --slow-mo 300 --visual-out captures/verify/bing_search_text
```

The verifier loads `WebAI2API/src/backend/adapter/<adapter_id>.js`, launches a Camoufox browser, calls the adapter `manifest.generate()` with the prompt, and reports whether text or image output was returned. This is an end-to-end browser check; it can fail because of network access, login state, captchas, or site layout changes.

When `--visual-out` is provided, the verifier writes a review bundle:

- `verify.json`: machine-readable status, result metadata, and step list.
- `timeline.md`: human-readable step timeline.
- `screenshots/*.png`: screenshots captured at verifier and template-runner steps.
- `trace.zip`: Playwright trace when tracing is available.
- `final-page.html` or `error-page.html`: final DOM snapshot.

`--visual` forces a headed browser and overlays the current verification step inside the page. `--slow-mo <ms>` adds a delay after each observed step. `--pause-on-error` leaves the browser open when verification fails.

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

Use `--browser-controls` to complete the recording flow from a floating control panel inside the opened browser instead of pressing Enter in the terminal. The panel has these stages:

- `Capture baseline`: finish login/navigation/setup and capture the before snapshot.
- `Start recording`: begin one action segment, optionally with a label.
- `Finish action`: close the current segment and prepare the next one.
- `Finish capture`: close the current segment and stop recording.

With browser controls, the default maximum is 20 action segments. Pass `--action-count N` to lower or raise that limit. Without browser controls, `--action-count N` repeats the terminal prompt N times and writes each prompt as a separate action segment.

## AI-Assisted Action Capture

Use `--ai-record-action` when you want an AI controller to perform the target action before `pnpm analyze`.

```bash
WEBADAPTERTOOLS_AI_API_KEY=sk-... \
pnpm collect https://example.com/app \
  --out captures/ai-action \
  --ai-record-action \
  --ai-goal "type a test message, submit it, and wait for the response" \
  --ai-input "hello" \
  --ai-provider langgraph \
  --ai-mode hybrid
```

Modes:

- `--ai-mode hybrid`: AI tries safe structured actions first, then falls back to human assistance when confidence is low or execution fails.
- `--ai-mode auto`: AI-only. The capture fails instead of asking for human help.
- `--ai-mode assist`: AI does not operate the page; it gives human instructions and records the human action.

The AI provider is OpenAI-compatible and uses these environment variables:

- `WEBADAPTERTOOLS_AI_API_KEY` or `OPENAI_API_KEY`
- `WEBADAPTERTOOLS_AI_BASE_URL` (optional, defaults to `https://api.openai.com/v1`)
- `WEBADAPTERTOOLS_AI_MODEL` (optional, defaults to `gpt-5.4-mini`)
- `WEBADAPTERTOOLS_AI_PROVIDER=raw|langgraph` (optional, defaults to `raw`)

Use `--ai-provider langgraph` to route AI decisions through a LangGraph `StateGraph` node backed by LangChain `ChatOpenAI`. This makes the decision call visible as a graph/model stack in LangSmith when tracing is enabled:

```bash
export LANGSMITH_TRACING=true
export LANGSMITH_API_KEY=lsv2_...
export LANGSMITH_PROJECT=web-adapter-tools
export LANGCHAIN_CALLBACKS_BACKGROUND=false
export WEBADAPTERTOOLS_AI_API_KEY=sk-...

pnpm collect https://example.com/app \
  --out captures/ai-action \
  --ai-record-action \
  --ai-goal "search for the test query and wait for results" \
  --ai-input "test query" \
  --ai-provider langgraph \
  --ai-mode hybrid \
  --browser-controls
```

The default `raw` provider keeps the direct OpenAI-compatible HTTP call for minimal dependencies and simpler debugging.

The controller only accepts structured JSON decisions and only executes whitelisted browser actions (`fill`, `click`, `press`, `wait`) against captured element `idRef` targets. It does not run AI-generated JavaScript. Login, captcha, payment, account, password, purchase, and delete-like targets trigger human fallback or failure.

When human fallback is needed, use `--browser-controls` for in-page instructions:

```bash
pnpm collect https://example.com/app \
  --out captures/ai-action \
  --ai-record-action \
  --ai-goal "search for the test query and wait for results" \
  --ai-input "test query" \
  --ai-mode hybrid \
  --browser-controls
```

AI-assisted captures write the normal `events/diff/network` files plus `actions/segments/<action-id>/controller.json`, which records AI decisions, human fallback instructions, and completion status.

Typical workflow:

```bash
pnpm collect https://example.com/app --out captures/action --record-action --user-data-dir profiles/example
pnpm collect https://example.com/app --out captures/ai-action --ai-record-action --ai-goal "send a message and wait for the response" --ai-input "hello"
pnpm collect https://example.com/app --out captures/action --record-action --browser-controls --user-data-dir profiles/example
pnpm analyze captures/action
```
