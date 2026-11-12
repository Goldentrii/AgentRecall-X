# Privacy policy: hosted AgentRecall at recall.aiakada.com

Last updated: 2026-11-12

This policy covers the hosted AgentRecall service at `https://recall.aiakada.com` ("the service"). It does not cover AgentRecall installed on your own computer: that version keeps everything on your machine and sends nothing to us.

The service is a free, early-stage project run by one person. It has no ads, no analytics and no trackers, and your data is never sold or shared for marketing.

## Who is responsible

Data controller (GDPR Art. 4(7)): **Tong Wu**, contact: **tongwu0824@gmail.com**.

Use that address for questions, data requests and deletion. Please don't post personal data in public GitHub issues.

## What we store

| Data | Where it comes from | Why |
|---|---|---|
| **Your memory**: what your AI agents save through AgentRecall (notes, decisions, session summaries, corrections, insights, project state) | Your agents, when they call AgentRecall tools | This is the service itself |
| **Your sign-in account id**: the numeric GitHub account id, or the Google account id (`sub`) | GitHub or Google, when you sign in | To know which memory space is yours |
| **Sign-in records**: which apps you connected (the name the app gives itself, its callback address) and when; access and refresh tokens, stored only as one-way hashes | The sign-in flow | To keep you signed in and let you revoke access |
| **Operator-issued tokens** (if you got one instead of signing in): a label and the creation date; the token itself only as a one-way hash | The operator | Same as above |
| **Per-agent activity**: for each agent that used your memory (identified by its sign-in or token, not by anything it says): the name the app reports about itself (cut to 60 characters), first and last time seen, the name of the last tool it called (for example `recall`) and a count of tool calls. No request content, no memory text, no addresses. Kept in a separate file from your memory (so it is not in "Download my memory") and written at most once a minute | Each request | To show you, on the website, which agents are using your memory and when |
| **Log lines**: for each request the time, method, path (no query string), your user id, result code and duration; sign-in events (the GitHub/Google account id and your user id, also for refused sign-ins); error messages | Each request | To run, debug and protect the service |

What we do **not** collect: your name, your email address, your GitHub or Google password, your profile or your repositories. Request bodies, tokens and query strings are never written to the log. From GitHub we request no permissions (scopes); from Google only `openid`.

Your IP address is used to rate-limit requests. The server keeps it **in memory only, for at most 1 hour**, and does not write it to any file. The reverse proxy in front of the server may include it in its own error lines (for example a failed TLS connection); those rotate out with the other logs.

The website sets two kinds of strictly necessary cookies, both HttpOnly and SameSite=Lax (and Secure over https), and no others:

- **Sign-in binding** (`ar_review_login_<id>`): valid for 10 minutes, sent only to the sign-in callback, ties a sign-in to the browser that started it.
- **Site session** (`ar_site` for `/connect` and `ar_review` for `/review`, the same random value in both): created when you sign in on the website, valid for 30 minutes, then you sign in again. Each cookie is sent only to its own pages, never to the MCP endpoint. It lets you manage your connected agents, download your memory and review corrections. The session itself is kept in the server's memory only and disappears when you sign out or the server restarts.

No analytics, advertising or tracking cookies are used, and the website loads no fonts, scripts or images from other sites.

Your memory is **not end-to-end encrypted**. It is protected in transit (HTTPS) and on the server by access controls, but the operator could technically read it. The operator does not read users' memory, except where a user asks for help, or where it is strictly needed to keep the service secure (for example reviewing a correction proposal flagged for approval).

## Where it is stored

On one server operated by Amazon Web Services (AWS Lightsail) in **Frankfurt, Germany (EU)**. AWS acts as our processor (hosting) under its data processing terms. Sign-in itself happens at GitHub or Google under their own privacy policies; they learn that you signed in to this service.

## Legal basis

- Providing the service you signed up for: GDPR Art. 6(1)(b) (contract).
- Short-lived request logs and rate limiting for security and abuse prevention: GDPR Art. 6(1)(f) (legitimate interest).

## How long we keep it

- **Memory:** until you delete it or ask us to delete your account.
- **Sign-ins:** access tokens expire after 1 hour, refresh tokens after 30 days, and every sign-in ends after at most 90 days. Ended sign-in records are removed after at most 30 more days.
- **Logs:** rotated automatically; at most about 100 MB of recent lines are kept (about 50 MB each for the server and the proxy), usually a few days to weeks.
- **Backups:** if server snapshots are enabled, they are kept for up to 7 days, so deleted data disappears from backups within 7 days.

## Your rights

You can ask for access to your data, a copy in a portable format, correction, deletion, restriction or objection (GDPR Art. 15–21). Write to the contact above; we answer within one month. **Download your memory yourself (data portability, Art. 20).** After signing in at `https://recall.aiakada.com/connect`, "Download my memory" gives you a .tar archive of everything stored in your memory space (plain markdown and JSON files), streamed straight from the server. You can also see there which apps are connected to your account and disconnect any of them. Deleting your account removes your memory space, your sign-in records and the link to your GitHub/Google account.

You also have the right to complain to a data protection supervisory authority, for example the one in your EU country of residence.

## Limits and changes

The service is offered as-is, without guarantees of availability or of keeping data forever; keep your own copy of anything important. Each user has a storage limit (currently 100 MB; the operator can change it) and a request rate limit.

If this policy changes in a way that matters, the date above changes and the change is visible in this file's history on GitHub.
