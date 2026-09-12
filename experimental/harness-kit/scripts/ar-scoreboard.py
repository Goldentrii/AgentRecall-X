#!/usr/bin/env python3
"""
ar-scoreboard.py — AgentRecall health scoreboard.
Modes: --snapshot (compute + append), --digest (print + maybe refresh), no args = --digest

SessionStart hook: --digest stdout is injected into every session.
"""

import json
import os
import sys
import glob
import datetime
import re
from pathlib import Path

AR_ROOT = Path(os.environ.get("AR_ROOT", "~/.agent-recall")).expanduser()
SCOREBOARD = AR_ROOT / "scoreboard.json"
REFLECT_STATE = AR_ROOT / "reflection-state.json"
MAX_SNAPSHOTS = 500
FRESH_WINDOW_S = 6 * 3600  # 6 hours
DEDUP_WINDOW_S = 30 * 60   # 30 minutes


# ── Atomic write ──────────────────────────────────────────────────────────────

def atomic_write(path: Path, data: dict) -> None:
    """Write JSON to path atomically via .tmp + os.replace."""
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


# ── Safe loaders ──────────────────────────────────────────────────────────────

def load_json_safe(path: Path, default=None):
    """Load JSON, return default on any error."""
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def parse_date_safe(s: str):
    """Parse YYYY-MM-DD or ISO datetime prefix into datetime. Return None on failure."""
    if not s:
        return None
    try:
        return datetime.datetime.strptime(str(s)[:10], "%Y-%m-%d")
    except Exception:
        return None


# ── Metrics ───────────────────────────────────────────────────────────────────

def compute_corrections(canonical_slugs: set, now: datetime.datetime):
    """Count corrections in canonical project dirs dated within last 7d and 30d."""
    cutoff_7 = now - datetime.timedelta(days=7)
    cutoff_30 = now - datetime.timedelta(days=30)
    count_7 = 0
    count_30 = 0

    for slug in canonical_slugs:
        corr_dir = AR_ROOT / "projects" / slug / "corrections"
        if not corr_dir.is_dir():
            continue
        for fpath in corr_dir.glob("*.json"):
            try:
                data = load_json_safe(fpath)
                if data is None:
                    continue
                items = data if isinstance(data, list) else [data]
                for item in items:
                    dt = parse_date_safe(item.get("date", ""))
                    if dt is None:
                        continue
                    # Higher threshold first per DoD rule 3
                    if dt > cutoff_7:
                        count_7 += 1
                        count_30 += 1
                    elif dt > cutoff_30:
                        count_30 += 1
            except Exception:
                pass

    return count_7, count_30


def compute_insights():
    """Return (total, confirmed_2plus, promotion_rate_pct) or (None, None, None)."""
    data = load_json_safe(AR_ROOT / "insights-index.json")
    if data is None:
        return None, None, None
    try:
        insights = data.get("insights", [])
        total = len(insights)
        two_plus = sum(1 for i in insights if i.get("confirmed_count", 0) >= 2)
        rate = round(two_plus / total * 100, 1) if total > 0 else 0.0
        return total, two_plus, rate
    except Exception:
        return None, None, None


def compute_recall_events(now: datetime.datetime):
    """Count feedback-log.json entries with date in last 30d."""
    data = load_json_safe(AR_ROOT / "feedback-log.json")
    if data is None:
        return None
    cutoff = now - datetime.timedelta(days=30)
    try:
        return sum(
            1 for item in data
            if (dt := parse_date_safe(item.get("date", ""))) is not None and dt > cutoff
        )
    except Exception:
        return None


def compute_dreams(now: datetime.datetime):
    """Return (last_success_date_str, stale_days) from status.json."""
    data = load_json_safe(AR_ROOT / "status.json")
    if data is None:
        return None, None
    dream_str = data.get("dream_last_success", "")
    dt = parse_date_safe(dream_str)
    if dt is None:
        return None, None
    stale = max(0, (now - dt).days)
    return str(dream_str)[:10], stale


def compute_sync_errors(now: datetime.datetime):
    """Count sync-errors.log lines with ISO timestamp in last 7d.
    If no timestamps found, return total non-empty line count."""
    log_path = AR_ROOT / "sync-errors.log"
    if not log_path.exists():
        return 0
    cutoff = now - datetime.timedelta(days=7)
    try:
        count_7 = 0
        total_lines = 0
        has_timestamps = False
        with open(log_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                total_lines += 1
                m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})", line)
                if m:
                    has_timestamps = True
                    try:
                        dt = datetime.datetime.fromisoformat(m.group(1))
                        if dt > cutoff:
                            count_7 += 1
                    except Exception:
                        pass
        return count_7 if has_timestamps else total_lines
    except Exception:
        return None


def compute_ghost_dirs(canonical_slugs: set):
    """Count visible (non-hidden) directories in projects/ not in canonical set."""
    proj_base = AR_ROOT / "projects"
    if not proj_base.is_dir():
        return None
    ghosts = 0
    for entry in proj_base.iterdir():
        if entry.name.startswith("."):
            continue
        # fix5 (2026-09-11): the leading-underscore namespace is reserved
        # infrastructure (`_unclaimed` staging, `_archive`, `_index.md`-class
        # files) — excluded BY NAME from the ghost census, same class rule
        # the TypeScript core applies (class-not-instance: one underscore
        # rule, never one branch per known dir).
        if entry.name.startswith("_"):
            continue
        if not entry.is_dir():
            continue
        if entry.name not in canonical_slugs:
            ghosts += 1
    return ghosts


def compute_project_metrics(canonical_slugs: set, now: datetime.datetime) -> list:
    """Compute per-project journal_age_d and correction_age_d for canonical projects."""
    results = []
    for slug in sorted(canonical_slugs):
        proj_base = AR_ROOT / "projects" / slug

        # Journal age: newest file mtime under journal/
        journal_age_d = None
        jdir = proj_base / "journal"
        if jdir.is_dir():
            try:
                files = [f for f in jdir.iterdir() if f.is_file() or f.is_dir()]
                if files:
                    newest = max(files, key=lambda f: f.stat().st_mtime)
                    age_s = (now - datetime.datetime.fromtimestamp(newest.stat().st_mtime)).total_seconds()
                    journal_age_d = max(0, int(age_s / 86400))
            except Exception:
                pass

        # Correction age: newest correction date field across all .json files
        correction_age_d = None
        corr_dir = proj_base / "corrections"
        if corr_dir.is_dir():
            try:
                newest_dt = None
                for fpath in corr_dir.glob("*.json"):
                    data = load_json_safe(fpath)
                    if data is None:
                        continue
                    items = data if isinstance(data, list) else [data]
                    for item in items:
                        dt = parse_date_safe(item.get("date", ""))
                        if dt is not None and (newest_dt is None or dt > newest_dt):
                            newest_dt = dt
                if newest_dt is not None:
                    correction_age_d = max(0, (now - newest_dt).days)
            except Exception:
                pass

        results.append({
            "slug": slug,
            "journal_age_d": journal_age_d,
            "correction_age_d": correction_age_d,
        })
    return results


# ── Reflection state ──────────────────────────────────────────────────────────

REFLECT_DEFAULT = {
    "version": 1,
    "last_reflection": None,
    "sessions_since": 0,
    "K": 10,
    "last_increment": None,
}


def load_or_init_reflection_state() -> dict:
    """Load reflection-state.json; create with defaults if missing."""
    state = load_json_safe(REFLECT_STATE)
    if state is None:
        atomic_write(REFLECT_STATE, REFLECT_DEFAULT.copy())
        return REFLECT_DEFAULT.copy()
    # Back-fill any missing keys
    updated = False
    for k, v in REFLECT_DEFAULT.items():
        if k not in state:
            state[k] = v
            updated = True
    if updated:
        atomic_write(REFLECT_STATE, state)
    return state


def increment_sessions_since(state: dict) -> tuple:
    """Increment sessions_since if >30min since last increment. Returns (state, did_increment)."""
    now = datetime.datetime.now()
    last_inc = state.get("last_increment")

    should_increment = True
    if last_inc is not None:
        try:
            last_dt = datetime.datetime.fromisoformat(last_inc)
            if (now - last_dt).total_seconds() < DEDUP_WINDOW_S:
                should_increment = False
        except Exception:
            pass  # Malformed last_increment → allow increment

    if should_increment:
        state["sessions_since"] = state.get("sessions_since", 0) + 1
        state["last_increment"] = now.isoformat()
        atomic_write(REFLECT_STATE, state)

    return state, should_increment


# ── Snapshot ──────────────────────────────────────────────────────────────────

def load_canonical_projects() -> tuple:
    """Load (projects_list, canonical_slugs_set) from status.json."""
    data = load_json_safe(AR_ROOT / "status.json")
    if data is None:
        return [], set()
    projects = data.get("projects", [])
    slugs = {p["slug"] for p in projects if "slug" in p}
    return projects, slugs


def compute_snapshot() -> dict:
    """Compute all metrics and return a snapshot dict."""
    now = datetime.datetime.now()
    ts = now.strftime("%Y-%m-%dT%H:%M:%S")

    _, canonical_slugs = load_canonical_projects()

    corrections_7d, corrections_30d = compute_corrections(canonical_slugs, now)
    insights_total, insights_confirmed_2plus, promotion_rate_pct = compute_insights()
    recall_events_30d = compute_recall_events(now)
    dreams_last_success, dreams_stale_days = compute_dreams(now)
    sync_errors_7d = compute_sync_errors(now)
    ghost_project_dirs = compute_ghost_dirs(canonical_slugs)

    # sessions_since_reflection from current state (pre-increment)
    reflect = load_or_init_reflection_state()
    sessions_since_reflection = reflect.get("sessions_since", 0)

    project_metrics = compute_project_metrics(canonical_slugs, now)

    return {
        "ts": ts,
        "global": {
            "corrections_7d": corrections_7d,
            "corrections_30d": corrections_30d,
            "insights_total": insights_total,
            "insights_confirmed_2plus": insights_confirmed_2plus,
            "promotion_rate_pct": promotion_rate_pct,
            "recall_events_30d": recall_events_30d,
            "dreams_last_success": dreams_last_success,
            "dreams_stale_days": dreams_stale_days,
            "sync_errors_7d": sync_errors_7d,
            "ghost_project_dirs": ghost_project_dirs,
            "sessions_since_reflection": sessions_since_reflection,
        },
        "projects": project_metrics,
    }


def append_snapshot(snapshot: dict) -> dict:
    """Append snapshot to scoreboard.json, cap at MAX_SNAPSHOTS, return full board."""
    board = load_json_safe(SCOREBOARD, {"version": 1, "snapshots": []})
    if not isinstance(board, dict) or not isinstance(board.get("snapshots"), list):
        board = {"version": 1, "snapshots": []}

    board["snapshots"].append(snapshot)
    # FIFO cap: highest threshold first (drop oldest)
    if len(board["snapshots"]) > MAX_SNAPSHOTS:
        board["snapshots"] = board["snapshots"][-MAX_SNAPSHOTS:]

    atomic_write(SCOREBOARD, board)
    return board


def get_latest_snapshot() -> tuple:
    """Return (snapshot_dict, age_in_seconds). age is None if ts unparseable."""
    board = load_json_safe(SCOREBOARD)
    if not board or not isinstance(board.get("snapshots"), list) or not board["snapshots"]:
        return None, None
    latest = board["snapshots"][-1]
    ts_str = latest.get("ts", "")
    try:
        ts_dt = datetime.datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%S")
        age_s = (datetime.datetime.now() - ts_dt).total_seconds()
        return latest, age_s
    except Exception:
        return latest, None  # Can't determine age → treat as stale


# ── Taxonomy ──────────────────────────────────────────────────────────────────

def load_taxonomy() -> tuple:
    """Return (data_dict_or_None, present_bool)."""
    tax_path = AR_ROOT / "taxonomy.json"
    if not tax_path.exists():
        return None, False
    data = load_json_safe(tax_path)
    return data, data is not None


# ── Digest formatter ──────────────────────────────────────────────────────────

def _na(val, fmt=str) -> str:
    """Format a value or return 'n/a'."""
    if val is None:
        return "n/a"
    try:
        return fmt(val)
    except Exception:
        return "n/a"


def format_digest(snapshot: dict) -> str:
    """Format ≤8-line digest from a snapshot dict. Never raises."""
    lines = ["── Pareto Scoreboard ──────────────────────────────"]

    try:
        g = snapshot.get("global", {})
        projects = snapshot.get("projects", [])

        # signal line
        c7 = g.get("corrections_7d")
        c30 = g.get("corrections_30d")
        lines.append(f" signal   {_na(c7)} corrections/7d · {_na(c30)}/30d")

        # promote line
        ins_total = g.get("insights_total")
        ins_2plus = g.get("insights_confirmed_2plus")
        pct = g.get("promotion_rate_pct")
        if ins_total is not None and ins_2plus is not None and pct is not None:
            lines.append(f" promote  {ins_2plus}/{ins_total} insights ≥2 confirms ({pct}%)")
        else:
            lines.append(f" promote  n/a (insights unavailable)")

        # loops line — highest staleness threshold first
        dreams_stale = g.get("dreams_stale_days")
        sync_e = g.get("sync_errors_7d")
        recall_e = g.get("recall_events_30d")

        if dreams_stale is None:
            dreams_part = "dreams n/a"
        elif dreams_stale > 7:
            dreams_part = f"dreams STALE {dreams_stale}d"
        else:
            dreams_part = f"dreams ok {dreams_stale}d"

        sync_s = f"{_na(sync_e)}/7d"
        recall_s = f"{_na(recall_e)}/30d"
        lines.append(f" loops    {dreams_part} · sync-errors {sync_s} · recall {recall_s}")

        # reflect line
        tax_data, tax_present = load_taxonomy()
        state = load_or_init_reflection_state()
        K = state.get("K", 10)
        sessions_since = state.get("sessions_since", 0)
        due = max(0, K - sessions_since)
        due_str = "REFLECT DUE NOW" if due == 0 else f"due in {due} sessions"

        if not tax_present:
            lines.append(" reflect  taxonomy not seeded")
        else:
            try:
                classes = tax_data.get("classes", []) if tax_data else []
                n_classes = len(classes)
                # Headline count = confirmed phantoms only; provisional keyword
                # matches are candidates pending /arreflect triage, never headline
                n_phantom = sum(
                    sum(1 for m in cls.get("members", [])
                        if m.get("phantom", False) and not m.get("provisional", False))
                    for cls in classes
                )
                n_provisional = sum(
                    sum(1 for m in cls.get("members", []) if m.get("provisional", False))
                    for cls in classes
                )
                n_unclassified = len(tax_data.get("unclassified", []))
                lines.append(
                    f" reflect  {n_classes} classes · {n_phantom} phantom · "
                    f"{n_provisional} provisional · {n_unclassified} unclassified · {due_str}"
                )
            except Exception as e:
                lines.append(f" reflect  n/a (taxonomy parse error: {str(e)[:30]})")

        # stale line: top 3 by journal_age_d > 14d, descending (highest first)
        stale = [
            p for p in projects
            if isinstance(p.get("journal_age_d"), int) and p["journal_age_d"] > 14
        ]
        stale.sort(key=lambda p: p["journal_age_d"], reverse=True)
        top3 = stale[:3]
        if top3:
            parts = " · ".join(f"{p['slug']} {p['journal_age_d']}d" for p in top3)
            lines.append(f" stale    {parts}")

        # action footer — reuses `due` computed above (works even when
        # taxonomy is absent; reflection state is already loaded, no re-read)
        if due == 0:
            lines.append(" ⚡ REFLECT DUE — run /arreflect")
        else:
            lines.append(" → /arstart board · /arsave · /arrecall · /arreflect")

    except Exception as e:
        lines.append(f" n/a (digest error: {str(e)[:50]})")

    return "\n".join(lines)


# ── Modes ─────────────────────────────────────────────────────────────────────

def run_snapshot() -> None:
    """--snapshot: compute, append, print one confirmation line. May exit 1 on failure."""
    try:
        snapshot = compute_snapshot()
        append_snapshot(snapshot)
        g = snapshot["global"]
        print(
            f"snapshot appended at {snapshot['ts']} — "
            f"corrections/7d={g.get('corrections_7d')} "
            f"insights={g.get('insights_total')} "
            f"dreams_stale={g.get('dreams_stale_days')}d"
        )
    except Exception as e:
        print(f"snapshot failed: {e}", file=sys.stderr)
        sys.exit(1)


def run_digest() -> None:
    """--digest: ensure fresh snapshot, print digest, increment sessions_since. Always exits 0."""
    try:
        latest, age_s = get_latest_snapshot()
        stale = (latest is None) or (age_s is None) or (age_s > FRESH_WINDOW_S)

        if stale:
            try:
                snapshot = compute_snapshot()
                append_snapshot(snapshot)
                latest = snapshot
            except Exception as e:
                if latest is None:
                    # Nothing usable — print minimal digest and exit
                    print("── Pareto Scoreboard ──────────────────────────────")
                    print(f" n/a (snapshot unavailable: {str(e)[:50]})")
                    # Still increment sessions_since
                    try:
                        state = load_or_init_reflection_state()
                        increment_sessions_since(state)
                    except Exception:
                        pass
                    sys.exit(0)
                # Fall through with stale snapshot

        # Increment sessions_since (with 30-min dedup guard)
        try:
            state = load_or_init_reflection_state()
            increment_sessions_since(state)
        except Exception:
            pass  # Never crash digest over state update failure

        # Print digest
        try:
            print(format_digest(latest))
        except Exception as e:
            print("── Pareto Scoreboard ──────────────────────────────")
            print(f" n/a (format error: {str(e)[:50]})")

    except Exception as e:
        print("── Pareto Scoreboard ──────────────────────────────")
        print(f" n/a (internal error: {str(e)[:50]})")

    sys.exit(0)


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "--digest"
    if mode == "--snapshot":
        run_snapshot()
    else:
        run_digest()


if __name__ == "__main__":
    main()
