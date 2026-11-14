# AgentRecall tray (Windows, MVP)

A small tray app and one compact dark window (380x560) that is a door to the hosted AgentRecall at https://agentrecallx.com. Tauri v2, Rust back end, plain HTML/CSS/TypeScript front end. No change to the server was needed.

## What it does

- Sign in: opens your default browser for the GitHub sign-in on agentrecallx.com (OAuth 2.1, PKCE S256, dynamic client registration, loopback redirect on 127.0.0.1). Tokens go to the Windows Credential Manager. Tokens are refreshed automatically. Sign out (a link under the tabs, and the tray menu) deletes them.
- Status header: connected or offline (`GET /healthz`) and the server version. The server does not expose the account ID to a token, so the app shows "Signed in" only.
- Memory: calls `session_start` (cards mode) and shows the owner card, HARD RULES and project state card as text. If proposed rules await review, a button opens https://agentrecallx.com/review in the browser.
- Remember: sends text through the `remember` tool and shows the server's confirmation line.
- Recall: searches through the `recall` tool and lists results.
- Connect: copies the connect command for Claude Code, Codex or Cursor (read live from https://agentrecallx.com/connect.md, with a built-in fallback) and opens your dashboard (/connect).
- Offline: the last Memory view and the last recall results (up to 20) are shown with an "offline, as of <time>" label.
- Tray: left click toggles the window; menu has Open, Sign out, Quit. Closing the window hides it to the tray.

## Build and run

Requirements to run: Windows 11 with WebView2. Keep `WebView2Loader.dll` beside the exe.

### How the shipped exe was built (Docker cross-compile, no Windows toolchain)

The PC this was written on has no MSVC or MinGW, so the exe is cross-compiled to `x86_64-pc-windows-gnu` in a Linux container (`rust:1.97-bookworm`, `mingw-w64`, posix threads). Cargo registry and target dir live on a named volume, not in the Windows tree.

```
docker pull rust:1.97-bookworm
docker volume create ar-tray-cache
docker run -d --name ar-tray-build -v <abs path to apps/tray>:/work -v ar-tray-cache:/cache   -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target -w /work/src-tauri rust:1.97-bookworm sleep infinity
docker exec ar-tray-build bash -c "apt-get update && apt-get install -y mingw-w64 && rustup target add x86_64-pc-windows-gnu   && update-alternatives --set x86_64-w64-mingw32-gcc /usr/bin/x86_64-w64-mingw32-gcc-posix   && update-alternatives --set x86_64-w64-mingw32-g++ /usr/bin/x86_64-w64-mingw32-g++-posix"
npm ci && npm run build:ui            # on the host: produces dist/, which the exe embeds
docker exec ar-tray-build bash -c "CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc   cargo build --release --target x86_64-pc-windows-gnu --features custom-protocol"
docker cp ar-tray-build:/cache/target/x86_64-pc-windows-gnu/release/agent-recall-tray.exe release/
docker cp ar-tray-build:/cache/target/x86_64-pc-windows-gnu/release/WebView2Loader.dll release/
```

`--features custom-protocol` makes the exe serve the embedded `dist/` instead of a dev URL. Tests: `cargo test --release --target x86_64-pc-windows-gnu --features custom-protocol --no-run`, then run the produced `*.exe` on Windows.

### Native route (alternative)

Install Visual Studio Build Tools with the "Desktop development with C++" workload, then from PowerShell (not Git Bash, whose `/usr/bin/link` shadows the MSVC linker):

```
cd apps/tray
npm ci
npm run build          # release exe, no installer: src-tauri/target/release/agent-recall-tray.exe
npm run build:bundle   # optional installer (downloads NSIS/WiX tooling)
cargo test --manifest-path src-tauri/Cargo.toml
```

### Test hooks (test builds only)

The release exe has no test hooks. Build with `--features custom-protocol,test-hooks` (the Docker steps above, with a separate `CARGO_TARGET_DIR`, for example `/cache/target-hooks`) to get them. They live in `src-tauri/src/hooks.rs` and nothing else reads these variables:

- `AGENTRECALL_TRAY_TEST_BASE_URL`: replaces https://agentrecallx.com as the server origin. Only `http://127.0.0.1:<port>` is accepted; anything else stops the app at start. The URL allowlist for opening links gains that one origin and nothing more.
- `AGENTRECALL_TRAY_TEST_OPEN_LOG`: instead of opening the system browser, the app appends each URL to this file.
- `AGENTRECALL_TRAY_TEST_HEALTH_URL`: replaces the health check URL only. Pointing it at `http://127.0.0.1:9/healthz` simulates an unreachable server; the window must still open and show "Offline".

A test build also uses its own credential-store entry (`AgentRecall Tray (test)`) and cache directory (`%APPDATA%\com.agentrecall.tray.test`), so it can never touch a real sign-in or a real cache. Debug builds do not honour the variables; only the `test-hooks` feature does.

`npm run check:release` proves the shipped exe has none of it: it searches `release/agent-recall-tray.exe` for the variable names and the test service name (8-bit and UTF-16) and fails if one is present.

### End-to-end chain test

`node e2e/chain.mjs` (or `npm run e2e`) runs the real exe against a local server with a mock GitHub and walks the whole chain: start, sign in, Memory, Remember, Recall, Connect, sign out. It asserts what each screen shows and writes the storyboard images to `docs/chain/`; `docs/chain.md` explains them. Everything is local: the server is the real `packages/mcp-server` build with the provider mock preload from its tests, the test build writes the sign-in URL to a log instead of opening a browser, the harness plays the browser in headless Edge (which is only allowed to reach 127.0.0.1), and the app's webview is driven over DevTools (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`) with `playwright-core`.

Needs: the server built (`npm ci` at the repo root, then `npm run build` in `packages/core` and `packages/mcp-server`), `npm ci` here, the test-hooks exe at `release/agent-recall-tray-testhooks.exe` (override with `AR_CHAIN_EXE`), WebView2 and Microsoft Edge. Ports are 8150, 8151 and 8152 (DevTools, server, mock); set `AR_CHAIN_PORT` to start elsewhere. It deletes the test credential entry and the test cache directory before and after the run, and never touches the `AgentRecall Tray` entry.

## Where things live

- Tokens: Windows Credential Manager, entry `oauth-tokens` under `AgentRecall Tray`, one JSON blob of about 250 characters (two 47-character tokens, expiry, client id), far below the Credential Manager limit. Never in a file, never logged, never sent to the webview (`withGlobalTauri` is off; the webview only has event-listen permission). All log and error text passes through a redactor.
- Cache: `%APPDATA%\com.agentrecall.tray\cache.json`. **The cache holds your memory text** (the last Memory view and the last recall results) in plain JSON so it can be shown offline. It is capped (64 KiB memory text, 20 results of 2 KiB, 256 KiB file) and guarded by a lock.
- What sign out clears: the credential-store entry and the cache file. This happens on every sign-out path: the Sign out button, the tray menu, the server rejecting the refresh token, a second 401, and a failed save of rotated tokens. A request that was in flight during sign-out cannot write the cache afterwards.
- The webview makes no network calls (CSP `default-src 'self'`); Rust makes every HTTP call, and every response body is size-capped (1 MiB tool results, 64 KiB everything else). Opening URLs from the app is limited to https://agentrecallx.com and https://github.com.

## Security notes

- The loopback listener binds 127.0.0.1 on a random port. A request with the wrong path or wrong `state` gets an answer and the listener keeps waiting; only the real callback (our `state`) ends it. Sign-in times out after 5 minutes.
- Only an `invalid_grant` reply from the token endpoint signs you out. Any other error keeps your tokens and shows a retryable message. If the renewed tokens cannot be saved, the app tells you and signs you out rather than carrying on with a dead refresh token.
- Connect commands copied to the clipboard come from connect.md, which is treated as untrusted. A command is used only if it matches a strict shape: `claude mcp add ...` or `codex mcp add ...` (plus optionally `codex mcp login <name>`), made only of letters, digits, space and `- _ . / : =`, and containing `https://agentrecallx.com/mcp`; the Cursor snippet must be JSON with exactly one `mcpServers` entry whose only key is that URL. Anything else is replaced by a built-in command.
- The pending-review button appears only for the server's exact line (hourglass, then `N proposed correction(s) await(s) the owner's confirmation`) at the start of a line.
- Server text is rendered with `textContent`, never `innerHTML`.
- Sign out removes tokens from this machine. To revoke the grant on the server too, use "Open my dashboard" and disconnect the app there.

## Not in the MVP

- Approving or rejecting proposed rules inside the app (the server refuses tokens on /review; the app opens the page instead).
- A list of connected agents (same reason: /connect is browser-session only).
- Auto-update, code signing (Windows may show SmartScreen on first run), macOS and Linux builds, single-instance protection, launch at login.
