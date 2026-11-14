# AgentRecall tray (Windows, MVP)

A small tray app and one compact dark window (380x560) that is a door to the hosted AgentRecall at https://agentrecallx.com. Tauri v2, Rust back end, plain HTML/CSS/TypeScript front end. No change to the server was needed.

## What it does

- Sign in: opens your default browser for the GitHub sign-in on agentrecallx.com (OAuth 2.1, PKCE S256, dynamic client registration, loopback redirect on 127.0.0.1). Tokens go to the Windows Credential Manager. Tokens are refreshed automatically. Sign out deletes them.
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

### Testing offline start

Set `AGENTRECALL_TRAY_TEST_HEALTH_URL` (for example `http://127.0.0.1:9/healthz`) before starting the exe to point only the health check at a dead address. The window must still open and show "Offline".

## Where things live

- Tokens: Windows Credential Manager, entry `oauth-tokens` under `AgentRecall Tray`. Never in a file, never logged, never sent to the webview. All log and error text passes through a redactor.
- Cache: `%APPDATA%\com.agentrecall.tray\cache.json` in the app data dir. **The cache holds your memory text** (the last Memory view and the last recall results) in plain JSON so it can be shown offline. Sign out deletes it. Delete the file by hand at any time.
- The webview makes no network calls (CSP `default-src 'self'`); Rust makes every HTTP call. Opening URLs from the app is limited to https://agentrecallx.com and https://github.com.

## Security notes

- The loopback listener binds 127.0.0.1 on a random port, checks `state`, takes the first valid `/callback` request and then closes. Stray non-callback connections get a 404 and are ignored; sign-in times out after 5 minutes.
- Server text is rendered with `textContent`, never `innerHTML`.
- Sign out removes tokens from this machine. To revoke the grant on the server too, use "Open my dashboard" and disconnect the app there.

## Not in the MVP

- Approving or rejecting proposed rules inside the app (the server refuses tokens on /review; the app opens the page instead).
- A list of connected agents (same reason: /connect is browser-session only).
- Auto-update, code signing (Windows may show SmartScreen on first run), macOS and Linux builds, single-instance protection, launch at login.
