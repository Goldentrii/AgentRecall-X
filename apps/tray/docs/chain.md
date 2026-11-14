# The whole chain, step by step

These nine pictures were taken by `node e2e/chain.mjs` (see "End-to-end chain test" in `apps/tray/README.md`). It runs the real Windows tray app against a copy of the AgentRecall server on this PC. GitHub is replaced by a stand-in, so nothing here touched agentrecallx.com or github.com, and nothing is your real account. What you see in the app and in the server's own sign-in page is exactly what the real thing shows. The only difference is the last click: with a real GitHub, GitHub's own page asks for your GitHub login there.

Four things talk to each other:

- **The tray app** (a small window with four tabs). It never holds your keys itself.
- **Your browser**, used only for signing in.
- **The AgentRecall server**, which keeps your memory and answers the app.
- **Windows Credential Manager**, where the app keeps the sign-in key (a "token") after you sign in.

## How to tell you are connected

Look at the top right of the app window.

- `Connected · v3.5.3` means the server answers. You are not signed in yet.
- `Connected · v3.5.3 · Signed in` means the server answers and the app holds a valid key. This is the "all good" state. The version number is the server's.
- `Offline` means the server cannot be reached. Memory you looked at before is still shown, marked "offline, as of" a time.

You can also check Windows itself: open Credential Manager, then Windows Credentials, and look for the entry `oauth-tokens` under `AgentRecall Tray`. It is there while you are signed in and gone after you sign out.

## 1. Start (`chain/01-start-signed-out.png`)

You start the app. It asks the server "are you there?" (a tiny request called `/healthz`) and shows `Connected` with the server version. Because there is no key yet, it shows the sign-in screen with one button. Underneath: only the app talks to the server, never the window itself.

## 2. Press "Sign in with GitHub" (`chain/02-waiting-for-browser.png`)

You press the button. The app reads the server's sign-in instructions, registers itself with the server as "AgentRecall Tray", opens a small listener on your own PC (a door that only your PC can reach), and opens your normal browser at the server's sign-in page. The app now says "Finish signing in in your browser" and waits. You can press Cancel; it gives up by itself after five minutes.

## 3. The server's own sign-in page (`chain/03-server-sign-in-page.png`)

Your browser shows AgentRecall's page, not the app. It tells you where the result goes (your own PC), warns you to continue only if you just started this yourself, and names the program asking ("AgentRecall Tray"). You press "Continue with GitHub".

## 4. GitHub, then back to your PC (`chain/04-browser-signed-in.png`)

Your browser goes to GitHub, you approve, and GitHub sends you back to the server. The server checks the answer, then sends your browser to the door the app opened on your PC, with a one-time code. The app answers with a short page: "Signed in. You can close this tab and return to AgentRecall." The picture shows that page. Underneath: the app swaps the one-time code for the sign-in key at the server, and writes the key to Credential Manager. The key never goes into the app window and never into a file.

## 5. Memory (`chain/05-memory.png`)

The app window switches by itself to the Memory tab and the header now says `Signed in`. The text is what an agent would receive at the start of a session (your identity card, your hard rules, the current project card), fetched by the app through the server's `session_start` tool. This account is new, so it says there is no memory yet. A saved copy goes to a small file on your PC (`%APPDATA%\com.agentrecall.tray\cache.json`) so the tab still works offline. The key is not in that file.

## 6. Remember (`chain/06-remember.png`)

You type a sentence and press Remember. The app sends it to the server's `remember` tool, and the server answers with where it filed it ("Saved → ..."). That line is shown as the confirmation. The sentence in the test was "The harbour ferry leaves at 07:45 on weekdays."

## 7. Recall (`chain/07-recall.png`)

You search for "harbour ferry". The app calls the server's `recall` tool and lists what it finds. The sentence from step 6 is the first hit, so the memory you wrote is the memory you can read back. The same memory is what Claude Code, Codex or Cursor see once they are connected to this account.

## 8. Connect (`chain/08-connect.png`)

This tab gives you the line to paste into an agent so it uses the same memory: one for Claude Code, one for Codex, one for Cursor. Press a "Copy" button and it goes to your clipboard. The app only trusts a command of a strict, known shape and otherwise shows its built-in one (in the picture the built-in commands are shown, because the stand-in server's own page names a local address). "Open my dashboard" opens your server dashboard in your browser. The list scrolls inside the window; Sign out stays in view underneath.

## 9. Sign out (`chain/09-signed-out.png`)

You press Sign out. The app deletes the key from Credential Manager and deletes the saved copy of your memory from your PC, then shows the sign-in screen again. This is identical to the first picture. The test checks that the Credential Manager entry and the cache file are really gone. Signing out removes the key from this PC only; to also cancel the app's access on the server, use "Open my dashboard" and disconnect it there.

## What this run does not cover

The real GitHub page (a stand-in answered in its place), the real agentrecallx.com server and its web address, and the system tray icon itself (its menu has Open, Sign out and Quit, and does the same sign-out as the button).
