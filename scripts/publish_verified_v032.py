#!/usr/bin/env python3
"""Publish v0.3.2 only after the exact source's three platform builds succeed."""
import json
import os
import pathlib
import re
import subprocess

REPO = os.environ["GITHUB_REPOSITORY"]
SOURCE = "e971c93e8e468971c41a403ee3729d6052442c17"
VERSION = "v0.3.2"
assert REPO == "xzcode/shell-ex"

def api(method, endpoint, data=None, allow_missing=False):
    cmd = ["gh", "api", "--method", method, f"repos/{REPO}/{endpoint}"]
    if data is not None:
        cmd += ["--input", "-"]
    process = subprocess.run(cmd,
        input=None if data is None else json.dumps(data),
        text=True, capture_output=True)
    if process.returncode:
        if allow_missing and "HTTP 404" in process.stderr:
            return None
        raise RuntimeError(f"{method} {endpoint} failed: {process.stderr.strip()}")
    return json.loads(process.stdout)

def all_assets(release):
    rows = release["assets"]
    names = [a["name"] for a in rows]
    if len(set(names)) != len(names):
        raise RuntimeError("Duplicate asset names")
    for a in rows:
        if a.get("state") != "uploaded" or not str(a.get("digest", "")).startswith("sha256:"):
            raise RuntimeError(f"Asset not finalized: {a['name']}")
    return {a["name"]: (a["id"], a["size"], a.get("digest")) for a in rows}

def expected_installers(asset_names):
    for ext in ("dmg", "exe", "deb"):
        matches = [n for n in asset_names if n.startswith("Shell-EX_0.3.2_") and n.endswith("." + ext)]
        if len(matches) != 1:
            raise RuntimeError(f"Expected exactly one {ext} installer, found {matches}")
    for platform in ("macOS-Apple-Silicon", "Windows-x64", "Linux-x64"):
        for suffix in (".sha256", ".build.json"):
            if len([n for n in asset_names if n.startswith(f"Shell-EX-{platform}-") and n.endswith(suffix)]) != 1:
                raise RuntimeError(f"Missing release evidence: {platform}{suffix}")

source_ref = api("GET", f"git/commits/{SOURCE}")
assert source_ref["sha"] == SOURCE

notes = pathlib.Path("docs/releases/v0.3.2.md").read_text(encoding="utf-8")
assert "v0.3.2" in notes and "AES-256-GCM" in notes

draft_tag = f"build-{SOURCE[:12]}"
draft = api("GET", f"releases/tags/{draft_tag}", allow_missing=True)
published = api("GET", f"releases/tags/{VERSION}", allow_missing=True)
release = draft if draft and draft.get("draft") else published
if release is None:
    raise RuntimeError("No verified v0.3.2 build draft; re-run Desktop packages for source " + SOURCE)
if release["target_commitish"] != SOURCE:
    raise RuntimeError("Refusing to publish an installer from a different source commit")
assets_before = all_assets(release)
expected_installers(assets_before.keys())

if not published:
    if not release["draft"]:
        raise RuntimeError("Expected an unpublished build draft")
    ref = api("GET", f"git/ref/tags/{VERSION}", allow_missing=True)
    if ref is None:
        ref = api("POST", "git/refs", {"ref": f"refs/tags/{VERSION}", "sha": SOURCE})
    if ref["object"]["sha"] != SOURCE or ref["object"]["type"] != "commit":
        raise RuntimeError("Release tag does not point to the accepted build source")
    published = api("PATCH", f"releases/{release['id']}", {
        "tag_name": VERSION, "target_commitish": SOURCE, "name": "Shell EX v0.3.2",
        "draft": False, "prerelease": False, "make_latest": "true", "body": notes,
    })

if published["draft"] or published["prerelease"] or published["tag_name"] != VERSION:
    raise RuntimeError("Release is not in the requested published state")
if all_assets(published) != assets_before:
    raise RuntimeError("Release assets changed unexpectedly")
assert api("GET", f"git/ref/tags/{VERSION}")["object"]["sha"] == SOURCE
latest = api("GET", "releases/latest")
assert latest["id"] == published["id"]
print("Shell EX v0.3.2 published:", published["html_url"])
print("Installers:", [n for n in assets_before if n.startswith("Shell-EX_0.3.2_")])
