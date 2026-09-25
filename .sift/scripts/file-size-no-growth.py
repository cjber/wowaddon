#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Agent Labs
# SPDX-License-Identifier: MIT
# catalog: file-size-no-growth@0.2.0
# sift-scope: changed
# sift-fix: split the file along its responsibilities before adding to it, or put the new code in a new file
"""Report a changed file over LIMIT lines that this change added or grew."""

from __future__ import annotations

import fnmatch
import os
import subprocess
import sys
from pathlib import Path

LIMIT = 1000
EXCLUDE = (
    "*.lock",
    "*-lock.json",
    "*-lock.yaml",
    ".sift/gate.py",
    ".sift/agents.py",
)


def line_count(data: bytes) -> int | None:
    return None if b"\0" in data else len(data.splitlines())


def base_lines(base: str, path: str) -> int:
    result = subprocess.run(["git", "show", f"{base}:{path}"], capture_output=True, check=False)
    if result.returncode == 128:
        return 0
    if result.returncode:
        sys.exit(f"git show {base}:{path} exited {result.returncode}")
    return line_count(result.stdout) or 0


def main() -> int:
    rule, base = os.environ["SIFT_RULE"], os.environ["SIFT_BASE"]
    corpus = set(Path(os.environ["SIFT_FILES"]).read_text().splitlines())
    hits = []
    for row in Path(os.environ["SIFT_CHANGED"]).read_text().splitlines():
        status, old, *renamed = row.split("\t")
        new = renamed[0] if renamed else old
        if status == "D" or new not in corpus or any(fnmatch.fnmatch(new, p) for p in EXCLUDE):
            continue
        after = line_count(Path(new).read_bytes())
        if after is None or after <= LIMIT:
            continue
        before = base_lines(base, old)
        if after > before:
            hits.append(f"{new}:1: {rule} grew from {before} to {after} lines, over the {LIMIT}-line limit")
    for hit in hits:
        print(hit)
    return int(bool(hits))


if __name__ == "__main__":
    sys.exit(main())
