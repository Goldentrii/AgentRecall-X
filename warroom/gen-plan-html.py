#!/usr/bin/env python3
"""Render MEMORY-TO-UNDERSTANDING-PLAN.md -> styled standalone HTML (warroom aesthetic, offline)."""
import html
import re
import sys

SRC = "/Users/tongwu/Projects/AgentRecall/docs/internal/MEMORY-TO-UNDERSTANDING-PLAN.md"
OUT = "/Users/tongwu/Projects/AgentRecall/warroom/memory-to-understanding-plan.html"


def inline(text):
    """Inline markdown -> HTML. Order matters: protect code spans first."""
    spans = []

    def stash(m):
        spans.append(m.group(1))
        return f"\x00{len(spans)-1}\x00"

    text = re.sub(r"`([^`]+)`", stash, text)
    text = html.escape(text, quote=False)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\w)\*([^*]+)\*(?!\w)", r"<em>\1</em>", text)
    # restore code spans (escaped)
    text = re.sub(r"\x00(\d+)\x00", lambda m: f"<code>{html.escape(spans[int(m.group(1))], quote=False)}</code>", text)
    return text


def render(md):
    lines = md.split("\n")
    out = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]

        # fenced code block
        if line.startswith("```"):
            i += 1
            buf = []
            while i < n and not lines[i].startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1  # skip closing fence
            code = html.escape("\n".join(buf), quote=False)
            out.append(f'<pre class="code"><code>{code}</code></pre>')
            continue

        # horizontal rule
        if re.match(r"^---+\s*$", line):
            out.append('<hr>')
            i += 1
            continue

        # headings
        m = re.match(r"^(#{1,4})\s+(.*)$", line)
        if m:
            level = len(m.group(1))
            text = inline(m.group(2))
            anchor = re.sub(r"[^a-z0-9]+", "-", m.group(2).lower()).strip("-")
            out.append(f'<h{level} id="{anchor}">{text}</h{level}>')
            i += 1
            continue

        # table
        if line.lstrip().startswith("|") and i + 1 < n and re.match(r"^\s*\|?[\s:|-]+\|?\s*$", lines[i + 1]):
            header = [c.strip() for c in line.strip().strip("|").split("|")]
            i += 2  # skip header + separator
            rows = []
            while i < n and lines[i].lstrip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            thead = "".join(f"<th>{inline(c)}</th>" for c in header)
            tbody = ""
            for r in rows:
                tbody += "<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>"
            out.append(f'<div class="tablewrap"><table><thead><tr>{thead}</tr></thead><tbody>{tbody}</tbody></table></div>')
            continue

        # blockquote (collect consecutive > lines)
        if line.startswith(">"):
            buf = []
            while i < n and lines[i].startswith(">"):
                buf.append(lines[i][1:].lstrip())
                i += 1
            # render inner as its own mini-doc (handles lists/code inside quotes loosely)
            inner = []
            for bl in buf:
                if bl.strip() == "":
                    inner.append("<br>")
                elif re.match(r"^[-*]\s+", bl):
                    inner.append(f"<div class='qli'>• {inline(re.sub(r'^[-*]\\s+', '', bl))}</div>")
                else:
                    inner.append(f"<div>{inline(bl)}</div>")
            out.append('<blockquote>' + "".join(inner) + '</blockquote>')
            continue

        # unordered list
        if re.match(r"^\s*[-*]\s+", line):
            items = []
            while i < n and re.match(r"^\s*[-*]\s+", lines[i]):
                items.append(inline(re.sub(r"^\s*[-*]\s+", "", lines[i])))
                i += 1
            out.append("<ul>" + "".join(f"<li>{it}</li>" for it in items) + "</ul>")
            continue

        # ordered list
        if re.match(r"^\s*\d+\.\s+", line):
            items = []
            while i < n and re.match(r"^\s*\d+\.\s+", lines[i]):
                items.append(inline(re.sub(r"^\s*\d+\.\s+", "", lines[i])))
                i += 1
            out.append("<ol>" + "".join(f"<li>{it}</li>" for it in items) + "</ol>")
            continue

        # blank
        if line.strip() == "":
            i += 1
            continue

        # paragraph (gather until blank/structural)
        buf = [line]
        i += 1
        while i < n and lines[i].strip() != "" and not re.match(r"^(#{1,4}\s|```|>|\s*[-*]\s|\s*\d+\.\s|---+\s*$)", lines[i]) and not lines[i].lstrip().startswith("|"):
            buf.append(lines[i])
            i += 1
        out.append(f"<p>{inline(' '.join(buf))}</p>")

    return "\n".join(out)


def main():
    with open(SRC) as f:
        md = f.read()
    body = render(md)
    page = TEMPLATE.replace("{{BODY}}", body)
    with open(OUT, "w") as f:
        f.write(page)
    print(f"wrote {OUT} ({len(page)} bytes)")


TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentRecall · Memory → Understanding Plan</title>
<link rel="stylesheet" href="static/fonts.css">
<style>
  :root{
    --bg:#FAF7F0;--surface:#F1ECDD;--surface-2:#E8E1CC;--ink:#2B2520;--ink-soft:#5A4E3F;
    --ink-faint:#8C7F6B;--rule:#DCD1B5;--rule-soft:#E6DFC8;--accent:#8A6A3F;--accent-soft:#C9A56C;
    --accent-dim:rgba(138,106,63,.10);--canvas:#1A1814;--canvas-ink:#E8E0D0;--canvas-line:#3A332B;
    --shadow:0 1px 2px rgba(43,37,32,.05),0 6px 20px rgba(43,37,32,.06);
  }
  @media (prefers-color-scheme:dark){:root{
    --bg:#15120E;--surface:#1E1A14;--surface-2:#28231B;--ink:#ECE3D2;--ink-soft:#BBAE97;
    --ink-faint:#897C68;--rule:#322B21;--rule-soft:#261F18;--accent:#C9A56C;--accent-soft:#E0C088;
    --accent-dim:rgba(201,165,108,.12);--canvas:#100E0B;--canvas-ink:#E8E0D0;--canvas-line:#2E2820;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.35);
  }}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--bg);color:var(--ink);font-family:'Nunito','Segoe UI',system-ui,sans-serif;
    font-size:15px;line-height:1.65;-webkit-font-smoothing:antialiased;padding:40px 20px 100px;}
  .wrap{max-width:920px;margin:0 auto;}
  h1,h2,h3,h4,.display{font-family:'Baloo 2','Nunito',sans-serif;font-weight:700;color:var(--ink);}
  h1{font-size:30px;line-height:1.15;margin:2px 0 4px;}
  h2{font-size:23px;margin:38px 0 12px;padding-top:18px;border-top:1px solid var(--rule);}
  h3{font-size:18px;margin:26px 0 8px;color:var(--accent);}
  h4{font-size:15px;margin:18px 0 6px;color:var(--ink-soft);text-transform:none;}
  p{margin:10px 0;color:var(--ink-soft);}
  strong{color:var(--ink);font-weight:700;}
  code{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:.84em;background:var(--surface-2);
    color:var(--accent);padding:1px 5px;border-radius:5px;}
  pre.code{font-family:'JetBrains Mono',ui-monospace,monospace;background:var(--canvas);color:var(--canvas-ink);
    padding:16px 18px;border-radius:12px;overflow-x:auto;font-size:12.5px;line-height:1.55;margin:14px 0;
    border:1px solid var(--canvas-line);}
  pre.code code{background:none;color:inherit;padding:0;font-size:inherit;}
  ul,ol{margin:10px 0 10px 26px;color:var(--ink-soft);}
  li{margin:5px 0;}
  blockquote{background:var(--accent-dim);border-left:3px solid var(--accent-soft);border-radius:0 10px 10px 0;
    padding:12px 16px;margin:14px 0;font-size:14px;color:var(--ink-soft);}
  blockquote .qli{margin:3px 0;}
  blockquote code{background:var(--surface);}
  hr{border:none;border-top:1px solid var(--rule);margin:30px 0;}
  .tablewrap{overflow-x:auto;margin:16px 0;border:1px solid var(--rule);border-radius:12px;box-shadow:var(--shadow);}
  table{border-collapse:collapse;width:100%;font-size:13.5px;background:var(--surface);}
  th,td{text-align:left;padding:9px 13px;border-bottom:1px solid var(--rule-soft);vertical-align:top;}
  th{background:var(--surface-2);color:var(--ink);font-family:'Baloo 2';font-weight:700;font-size:13px;}
  tr:last-child td{border-bottom:none;}
  td code{font-size:.8em;}
  .topbar{display:flex;align-items:center;gap:14px;margin-bottom:18px;}
  .logo{width:44px;height:44px;border-radius:12px;background:linear-gradient(140deg,var(--accent-soft),var(--accent));
    display:flex;align-items:center;justify-content:center;color:#fff;font-family:'Baloo 2';font-weight:800;font-size:24px;
    box-shadow:var(--shadow);flex-shrink:0;}
  .sub{font-size:13px;color:var(--ink-faint);margin-top:3px;}
  .back{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--accent);text-decoration:none;
    margin-bottom:22px;padding:6px 12px;border:1px solid var(--rule);border-radius:999px;background:var(--surface);}
  .back:hover{background:var(--surface-2);}
  .meta-banner{background:var(--surface);border:1px solid var(--rule);border-radius:14px;padding:14px 18px;
    margin-bottom:8px;box-shadow:var(--shadow);font-size:13px;color:var(--ink-faint);}
  .meta-banner b{color:var(--ink-soft);}
</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="changelog.html">← Changelog</a>
  <div class="topbar">
    <div class="logo">AR</div>
    <div>
      <div class="display" style="font-size:26px;line-height:1;">Memory → Understanding</div>
      <div class="sub">Implementer plan · 5 waves · fact-checked against the live tree</div>
    </div>
  </div>
  <div class="meta-banner"><b>Status:</b> orchestrator deliverable — a terminal coding agent implements. <b>REDLINE:</b> no version bump / publish / deploy / push in any step. Every claim verified against code; refuted assumptions corrected inline.</div>
  {{BODY}}
</div>
</body>
</html>
"""

if __name__ == "__main__":
    main()
