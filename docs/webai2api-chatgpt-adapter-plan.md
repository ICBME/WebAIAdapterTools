# WebAI2API ChatGPT Adapter Reference Plan

This document summarizes the interfaces and browser operations used by `WebAI2API/src/backend/adapter/chatgpt.js` and `WebAI2API/src/backend/adapter/chatgpt_text.js`. WebAdapterTools also exposes the same content as the built-in machine-readable plan `webai2api-chatgpt-reference`, which `pnpm ai-generate-adapter` can inject into AI capture.

## Adapter Module Contract

- Exports `manifest`.
- Implements `async function generate(context, prompt, imgPaths, modelId, meta = {})`.
- Reads `context.page` and `context.config`.
- Returns `{ text }`, an image download result, or `{ error, retryable?: false }`.
- Uses `TARGET_URL` / `getTargetUrl(config, workerConfig)` for navigation.
- Uses a stable `INPUT_SELECTOR`; ChatGPT currently uses `.ProseMirror`.
- Manifest fields: `id`, `displayName`, `description`, optional `configSchema`, `getTargetUrl`, `models`, `navigationHandlers`, `generate`.
- Common helpers: `sleep`, `humanType`, `safeClick`, `uploadFilesViaChooser`, `normalizePageError`, `waitForInput`, `gotoWithCheck`, `waitApiResponse`, `useContextDownload`, `logger`.

## Operation Plan

1. Open target page.
   Capture final URL, title, initial network, and whether a prepared login profile is required. Do not operate login, captcha, password, payment, authorization, account, or destructive controls.

2. Wait for primary input.
   Capture the prompt editor/input locator and verify it is visible and editable. Prefer stable role/label/placeholder/test-id/structural selectors.

3. Optionally select model.
   ChatGPT text uses a `Model selector` button, optional `Legacy models`, and a menu item or radio item matching `models[].codeName`. Capture this only when the target page exposes a safe selector and multi-model support is needed.

4. Optionally upload files.
   ChatGPT uses `Add files and more` plus `uploadFilesViaChooser`. Capture the upload entry, file chooser behavior, and upload/processing network endpoints. The reference upload completion endpoints are `backend-api/files` and `backend-api/files/process_upload_stream`.

5. Enter prompt.
   Focus the input with `safeClick`, type with `humanType`, and record input/change/key events so the generator can infer parameters and locators.

6. Prepare output wait before submit.
   Text generation starts `page.waitForResponse` before pressing Enter to avoid missing an SSE response. Capture reliable output evidence: DOM output, POST response, SSE completion, generated file status, or download endpoint.

7. Submit prompt.
   ChatGPT submits with `Enter` and keeps `Send prompt` as a button locator fallback. Capture the submit key/click event and target locator.

8. Extract text result.
   ChatGPT text watches `POST backend-api/f/conversation`, parses `data:` SSE lines, follows the assistant `channel=final` text message, appends patches at `/message/content/parts/0`, and finishes on `[DONE]`, `finished_successfully`, or `message_stream_complete`.

9. Extract image result.
   ChatGPT image watches `POST backend-api/f/conversation`, detects generated file evidence, then waits for `backend-api/files/download/file_` JSON with `file_name` and `download_url`. It ignores partial files and downloads through the browser context.

10. Detect failures.
    Normalize page errors, check HTTP status, empty output, rate limits, content rejection, login/captcha/verification states, and terminal model/account failures.

## Required Capture Evidence

- DOM: before/after snapshots, input locator, submit locator/key, output locator.
- Events: click, focus, input, change, key, submit, file-change.
- Network: submission endpoint, completion/stream response, upload processing endpoint, download/file endpoint when applicable.
- Controller: AI decisions, confidence, human fallback instructions, completion or failure reason.

## How Scripts Use This Plan

`pnpm ai-generate-adapter` can load this as `--plan webai2api-chatgpt-reference`. The script injects a compact form of the plan into each AI observation. AI then attempts the safe parts of the operation chain, asks for human assistance when it cannot safely continue, and writes the normal capture bundle for interface analysis and adapter generation.
