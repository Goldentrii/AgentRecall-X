# Privacy policy: hosted AgentRecall at agentrecallx.com

Last updated: 2026-11-14

This policy covers the hosted AgentRecall service at `https://agentrecallx.com` ("the service"). Until 14 November 2026 the service was reached at `https://recall.aiakada.com`; that address still reaches the same service, the same server and the same data, but signing in works only at the new address. It does not cover AgentRecall installed on your own computer: that version keeps everything on your machine and sends nothing to us.

The service is a free, early-stage project run by one person. It has no ads, no third-party analytics and no trackers, and your data is never sold or shared for marketing. To see whether the service works and how much it is used, the server keeps daily totals with no user ids, account ids or content (see "Daily usage counts and error alerts" below).

## Who is responsible

Data controller (GDPR Art. 4(7)): **Tong Wu**, contact: **tongwu0824@gmail.com**.

Use that address for questions, data requests and deletion. Please don't post personal data in public GitHub issues.

## What we store

| Data | Where it comes from | Why |
|---|---|---|
| **Your memory**: what your AI agents save through AgentRecall (notes, decisions, session summaries, corrections, insights, project state). Your (empty) memory space is created when you first sign in | Your agents, when they call AgentRecall tools | This is the service itself |
| **Your sign-in account id**: the numeric GitHub account id, or the Google account id (`sub`) | GitHub or Google, when you sign in | To know which memory space is yours |
| **Sign-in records**: which apps you connected (the name the app gives itself, its callback address) and when; access and refresh tokens, stored only as one-way hashes | The sign-in flow | To keep you signed in and let you revoke access |
| **Operator-issued tokens** (if you got one instead of signing in): a label and the creation date; the token itself only as a one-way hash | The operator | Same as above |
| **Per-agent activity**: for each agent that used your memory (identified by its sign-in or token, not by anything it says): the name the app reports about itself (cut to 60 characters), first and last time seen, the name of the last tool it called (for example `recall`) and a count of tool calls. No request content, no memory text, no addresses. Kept in a separate file from your memory (so it is not in "Download my memory") and written at most once a minute. It is deleted together with your account | Each request | To show you, on the website, which agents are using your memory and when |
| **Log lines**: for each request the time, method, path (no query string), your user id, result code and duration; sign-in events (the GitHub/Google account id and your user id, also for refused sign-ins); error messages | Each request | To run, debug and protect the service |

**Daily usage counts and error alerts.** For each day (UTC) the server keeps totals only: the number of requests to the endpoint AI agents connect to (including refused ones), tool calls per tool name (for example `recall`), the number of distinct users who used the service that day, new sign-ups, newly connected agents, errors by type and by part of the service, response times, views per page of this website, and which well-known website linked to a page (for example `github.com` or a search engine; any other website is counted only as "other", and the full address is never kept). These totals contain no user ids, account ids, tokens, IP addresses, browser details, addresses of pages beyond the fixed list of this site's pages, or memory content. To count distinct users, the server holds the user ids seen that day in its memory only and saves just the number. While the service has very few users, a day's totals can describe what a single person did that day (for example "1 user, 3 tool calls"); they still name no one. The totals are written to one file per day on the server and are not shared with anyone. When something breaks, the operator gets a short message through Telegram (a messaging service) with the type of error, how often it happened, which part of the service was affected, the place in the service's own code where it happened (file and line), the software version and the time; it contains no personal data either (no user ids, tokens, memory content or error text).

What we do **not** collect: your name, your email address, your GitHub or Google password, your profile or your repositories. Request bodies, tokens and query strings are never written to the log. From GitHub we request no permissions (scopes); from Google only `openid`.

Your IP address is used to rate-limit requests. The server keeps it **in memory only, for at most 1 hour**, and does not write it to any file. The reverse proxy in front of the server may include it in its own error lines (for example a failed TLS connection); those rotate out with the other logs.

The website sets two kinds of strictly necessary cookies, both HttpOnly and SameSite=Lax (and Secure over https), and no others:

- **Sign-in binding** (`ar_review_login_<id>`): valid for 10 minutes, sent only to the sign-in callback, ties a sign-in to the browser that started it.
- **Site session** (`ar_site` for `/connect` and `ar_review` for `/review`, the same random value in both): created when you sign in on the website, valid for 30 minutes, then you sign in again. Each cookie is sent only to its own pages, never to the MCP endpoint. It lets you manage your connected agents, download your memory and review corrections. The session itself is kept in the server's memory only and disappears when you sign out or the server restarts.

No analytics, advertising or tracking cookies are used (the daily usage counts need no cookies and store nothing in your browser), and the website loads no fonts, scripts or images from other sites.

Your memory is **not end-to-end encrypted**. It is protected in transit (HTTPS) and on the server by access controls, but the operator could technically read it. The operator does not read users' memory, except where a user asks for help, or where it is strictly needed to keep the service secure (for example reviewing a correction proposal flagged for approval).

## Where it is stored

On one server operated by Amazon Web Services (AWS Lightsail) in **Frankfurt, Germany (EU)**. AWS acts as our processor (hosting) under its data processing terms. Sign-in itself happens at GitHub or Google under their own privacy policies; they learn that you signed in to this service. Error alerts (described above, no personal data) are delivered to the operator through Telegram, which keeps them in the operator's chat history under its own privacy policy.

## Legal basis

- Providing the service you signed up for: GDPR Art. 6(1)(b) (contract).
- Short-lived request logs and rate limiting for security and abuse prevention: GDPR Art. 6(1)(f) (legitimate interest).
- Counting distinct daily users in the server's memory for the daily usage counts: GDPR Art. 6(1)(f) (legitimate interest in knowing whether the service works and is used). Only the number is saved.

## How long we keep it

- **Memory:** until you delete it or ask us to delete your account.
- **Replaced memory:** if you import with "Replace", the memory it replaced is kept for 7 days in a server-side trash folder, then deleted. Import staging files are deleted as soon as the import ends.
- **Sign-ins:** access tokens expire after 1 hour, refresh tokens after 30 days, and every sign-in ends after at most 90 days. Ended sign-in records are removed after at most 30 more days.
- **Logs:** rotated automatically; at most about 100 MB of recent lines are kept (about 50 MB each for the server and the proxy), usually a few days to weeks.
- **Daily usage counts:** about 400 days (13 months), then deleted automatically. They contain no user ids, account ids or content.
- **Backups:** if server snapshots are enabled, they are kept for up to 7 days, so deleted data disappears from backups within 7 days.

## Your rights

You can ask for access to your data, a copy in a portable format, correction, deletion, restriction or objection (GDPR Art. 15–21). Write to the contact above; we answer within one month. **Download your memory yourself (data portability, Art. 20).** After signing in at `https://agentrecallx.com/connect`, "Download my memory" gives you a .tar archive of everything stored in your memory space (plain markdown and JSON files), streamed straight from the server. You can also see there which apps are connected to your account and disconnect any of them. **Import your local memory.** The same page has "Import memory": you upload a .tar of your own local AgentRecall store (the page gives the command that packs only memory files, never config, keys, logs or telemetry). While it uploads, the file is unpacked into a temporary staging folder on the server that only that import can use; it is deleted when the import finishes, fails or your browser disconnects (a leftover of a server crash is removed within an hour of the next start). Only memory files are kept, and the server logs counts, not content. If you choose "Replace", your previous memory is not deleted at once: it is kept in a server-side trash folder (only the most recent replaced memory) for 7 days, so you can ask the operator to restore it, and then it is deleted (while in trash it is not part of your download). Always-follow rules (corrections, behaviour policies, the personal profile and the identity card) are left out unless you tick a box, because once imported they are active for all your agents at once; that is also why only you, signed in in a browser, can import. The trash copy does not count against your storage quota and only the latest one is kept. Deleting your account removes your memory space, your sign-in records and the link to your GitHub/Google account.

You also have the right to complain to a data protection supervisory authority, for example the one in your EU country of residence.

## Limits and changes

The service is offered as-is, without guarantees of availability or of keeping data forever; keep your own copy of anything important. Each user has a storage limit (currently 100 MB; the operator can change it) and a request rate limit.

If this policy changes in a way that matters, the date above changes and the change is visible in this file's history on GitHub.
