# The whole chain, step by step

These eleven pictures were taken by `node e2e/chain.mjs` (see "End-to-end chain test" in `apps/tray/README.md`). It runs the real Windows tray app against a copy of the AgentRecall server on this PC. GitHub is replaced by a stand-in, so nothing here touched agentrecallx.com or github.com, and nothing is your real account. The app is the real exe and the server is the real server code, so its pages match the real server's pages apart from GitHub's own screen; this run was not compared against the live agentrecallx.com. The one other difference is the last click: with a real GitHub, GitHub's own page asks for your GitHub login there.

Four things talk to each other:

- **The tray app** (a small window with four tabs: Rules, Notes, Search, Connect). It keeps the key in Windows Credential Manager, never in the window.
- **Your browser**, used only for signing in.
- **The AgentRecall server**, which holds your rules and answers the app.
- **Windows Credential Manager**, where the app keeps the sign-in key (a "token") after you sign in.

## How to tell you are connected

Look at the top right of the app window.

- `Connected · v3.5.3` means the server answers. You are not signed in yet.
- `Connected · v3.5.3 · Signed in` means the server answers and the app holds a valid key. This is the "all good" state. The version number is the server's.
- `Offline` means the server cannot be reached. The rules you looked at before are still shown, marked "offline, as of" a time.

You can also check Windows itself: open Credential Manager, then Windows Credentials, and look for the entry `oauth-tokens` under `AgentRecall Tray`. It is there while you are signed in and gone after you sign out.

## 1. Start (`chain/01-start-signed-out.png`)

You start the app. It asks the server "are you there?" (a tiny request called `/healthz`) and shows `Connected` with the server version. Because there is no key yet, it shows the sign-in screen with one button. Underneath: only the app talks to the server, never the window itself.

## 2. Press "Sign in with GitHub" (`chain/02-waiting-for-browser.png`)

You press the button. The app reads the server's sign-in instructions, registers itself with the server as "AgentRecall Tray", opens a small listener on your own PC (a door that only your PC can reach), and opens your normal browser at the server's sign-in page. The app now says "Finish signing in in your browser" and waits. You can press Cancel; it gives up by itself after five minutes.

## 3. The server's own sign-in page (`chain/03-server-sign-in-page.png`)

Your browser shows AgentRecall's page, not the app. It tells you where the result goes (your own PC), warns you to continue only if you just started this yourself, and names the program asking ("AgentRecall Tray"). You press "Continue with GitHub".

## 4. GitHub, then back to your PC (`chain/04-browser-signed-in.png`)

Your browser goes to GitHub, you approve, and GitHub sends you back to the server. The server checks the answer, then sends your browser to the door the app opened on your PC, with a one-time code. The app answers with a short page: "Signed in. You can close this tab and return to AgentRecall." The picture shows that page. Underneath: the app swaps the one-time code for the sign-in key at the server, and writes the key to Credential Manager. The key never goes into the app window and never into a file.

## 5. Rules, on a new account (`chain/05-rules-empty.png`)

The app window switches by itself to the Rules tab and the header now says `Signed in`. This account has taught its agents nothing yet, so the window says so and tells you how to start in two steps: 1. connect an agent in the Connect tab (a button opens that tab), 2. tell it "Remember this rule: ..." and approve the rule at agentrecallx.com/review. Behind the scenes the app asked the server's `session_start` tool what an agent would be told; the app turns that text into this view and shows none of the instructions that are meant for agents. A saved copy goes to a small file on your PC (`%APPDATA%\com.agentrecall.tray\cache.json`) so the tab can show it when the server cannot be reached (this run does not test that). The key is not in that file.

## 6. Another agent teaches a rule (`chain/06-rule-waiting.png`)

The test plays a second agent that is connected to the same account. It gives the server a correction. Because an agent cannot approve its own rule, the rule is not active yet: it waits for you. After Refresh the window offers "Review 1 proposed rule", which opens the review page in your browser. There is still no rule in the list.

## 7. You approve, every agent follows (`chain/07-rules.png`)

The test plays you approving the rule (the real page needs a browser sign-in; the test uses the server's operator command for the same step) and the other agent saves where it stands. Refresh shows "Rules every agent follows" with the rule, marked P0 for top priority, and "Where things stand" with the goal, what is next, blockers and open decisions as labelled rows. The test checks that no line meant for agents (fence markers, "call session_end", coaching text) is visible.

## 8. Notes (`chain/08-teach.png`)

You type a sentence and press "Save for your agents". The app sends it to the server's `remember` tool and says "Saved. Your agents can find this when they search." The server's own reply names an internal file path; the app does not show it. A note is not a rule: under the box the app says that a rule is proposed by an agent and approved at agentrecallx.com/review. The sentence in the test was "The harbour ferry leaves at 07:45 on weekdays."

## 9. Search (`chain/09-search.png`)

You search for "harbour ferry". Each result is a small card: the sentence, and a quiet line with what kind of thing it is (Journal, Note, Insight, Rule) and its date. The sentence from step 8 is there without any markup, so a sentence you saved is something your connected agents can find.

## 10. Connect (`chain/10-connect.png`)

The tab opens with "Add AgentRecall to each agent that should follow your rules." and one row per agent, each saying what to do with it: Claude Code and Codex are pasted into your terminal (Claude Code then needs /mcp to sign in, Codex's second line signs in), and Cursor's is a settings snippet you add to Cursor's MCP settings. Press a "Copy" button and it goes to your clipboard. The app only trusts a command of a strict, known shape and otherwise shows its built-in one (in the picture the built-in commands are shown, because the stand-in server's own page names a local address). "Open my dashboard" opens your server dashboard in your browser. The list scrolls inside the window; Sign out stays in view underneath.

## 11. Sign out (`chain/11-signed-out.png`)

You press Sign out. The app deletes the key from Credential Manager and deletes the saved copy from your PC, then shows the sign-in screen again. This is identical to the first picture. The test checks that the Credential Manager entry and the cache file are really gone. Signing out removes the key from this PC only. To also cancel the app's access on the server, "Open my dashboard" opens the page that, by the server's code, lists each connected agent with a Disconnect button (the test does not click it).

## What this run does not cover

The real GitHub page (a stand-in answered in its place), the real agentrecallx.com server and its web address, and the system tray icon itself (its menu has Open, Sign out and Quit, and does the same sign-out as the button).
