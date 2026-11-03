#!/usr/bin/python3 -I
"""Summarise fs-latency.jsonl: per-hour probe latency, cache lifetime, vnode churn, stalls.

  /usr/bin/python3 -I report.py [--hours 24] [--log <path>]

Per hour (UTC): ticks; cold lstat p50 and readdir(500) p50/max per tier;
slowest single op; ticks over the stall threshold; new vnodes/s p50;
disk read ops/s and device ms/op; and the file cache's lifetime — the
smallest canary age whose median residency fell below 50 % (">N s" when no
canary dropped within the oldest age seen).
"""

import argparse
import collections
import json
import os
import time


def pct(xs, q):
    xs = sorted(x for x in xs if x is not None)
    return xs[min(len(xs) - 1, int(len(xs) * q))] if xs else None


def lifetime(ticks):
    by_age = collections.defaultdict(list)
    for r in ticks:
        for c in r.get("canary", []):
            by_age[int(c["age_s"] // 30) * 30].append(c["resident"])
    if not by_age:
        return "-"
    for age in sorted(by_age):
        if pct(by_age[age], 0.5) < 0.5:
            return f"<{age + 30}s"
    return f">{max(by_age)}s"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--log", default=os.path.expanduser("~/.equin/logs/monitors/fs-latency.jsonl"))
    a = ap.parse_args()
    since = time.time() - a.hours * 3600
    hours = collections.OrderedDict()
    with open(a.log) as fh:
        for line in fh:
            r = json.loads(line)
            if r["t"] >= since:
                hours.setdefault(r["iso"][:13], []).append(r)
    print(f"{'hour (UTC)':13} {'n':>4} {'fg lstat':>8} {'bg lstat':>8} {'fg rd500':>8} {'bg rd500':>8} {'bg rdmax':>8} "
          f"{'max op':>8} {'stalls':>6} {'newvn/s':>7} {'rd ops/s':>8} {'ms/op':>6} {'cache':>7}")
    all_ticks = []
    for h, ts in hours.items():
        all_ticks += ts
        f = lambda v: "-" if v is None else (f"{v:.2f}" if v < 100 else f"{v:.0f}")
        print(f"{h:13} {len(ts):4} "
              f"{f(pct([r['fg']['lstat_p50'] for r in ts], .5)):>8} {f(pct([r['bg']['lstat_p50'] for r in ts], .5)):>8} "
              f"{f(pct([r['fg']['readdir500'] for r in ts], .5)):>8} {f(pct([r['bg']['readdir500'] for r in ts], .5)):>8} "
              f"{f(max(r['bg']['readdir500'] for r in ts)):>8} {f(max(r['max_op_ms'] for r in ts)):>8} "
              f"{sum(1 for r in ts if r['stall']):6} {f(pct([r.get('new_vnodes_s') for r in ts], .5)):>7} "
              f"{f(pct([r.get('disk_read_ops_s') for r in ts], .5)):>8} {f(pct([r.get('disk_read_ms_per_op') for r in ts], .5)):>6} "
              f"{lifetime(ts):>7}")
    if all_ticks:
        worst = max(all_ticks, key=lambda r: r["max_op_ms"])
        print(f"\nwindow: {len(all_ticks)} ticks, stalls (> threshold) {sum(1 for r in all_ticks if r['stall'])}, "
              f"slowest op {worst['max_op_ms']:.0f} ms at {worst['iso']}, cache lifetime {lifetime(all_ticks)}")
    print("(latencies in ms; lstat = p50 of 40 cold lstats; rd500 = one cold 500-entry readdir)")


if __name__ == "__main__":
    main()
