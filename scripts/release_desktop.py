#!/usr/bin/env python3
"""Stage and publish native installers from one immutable master source."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPO = os.environ.get("GITHUB_REPOSITORY", "")
SHA = os.environ.get("GITHUB_SHA", "")
OUT = ROOT / "release-out"
PLATFORMS = {
    "macOS-Apple-Silicon": ("aarch64-apple-darwin", "dmg/*.dmg", "_aarch64.dmg"),
    "Windows-x64": ("x86_64-pc-windows-msvc", "nsis/*.exe", "_x64-setup.exe"),
    "Linux-x64": ("x86_64-unknown-linux-gnu", "deb/*.deb", "_amd64.deb"),
}


def version():
    desktop = ROOT / "apps/desktop"
    v = json.loads((desktop / "package.json").read_text())["version"]
    assert re.fullmatch(r"\d+\.\d+\.\d+", v)
    assert json.loads((desktop / "src-tauri/tauri.conf.json").read_text())["version"] == v
    assert re.search(r'^version = "' + re.escape(v) + r'"$', (ROOT / "Cargo.toml").read_text(), re.M)
    return v


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True, cwd=ROOT)


def api(endpoint):
    return json.loads(gh("api", f"repos/{REPO}/{endpoint}"))


def digest(path):
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def source_guard():
    assert REPO == "xzcode/shell-ex"
    assert os.environ.get("GITHUB_REF") == "refs/heads/master"
    assert re.fullmatch(r"[0-9a-f]{40}", SHA)
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, cwd=ROOT).strip() == SHA


def checked_release(r, tag):
    assert r["tag_name"] == tag
    assert r["target_commitish"] == SHA, "Version already belongs to another source commit"
    if not r["draft"]:
        assert api("git/ref/tags/" + tag)["object"]["sha"] == SHA
    return r


def release(tag):
    release_id = os.environ.get("SHELL_EX_RELEASE_ID", "")
    if release_id:
        assert release_id.isdecimal()
        return checked_release(api("releases/" + release_id), tag)
    pages = json.loads(gh("api", "--paginate", "--slurp", f"repos/{REPO}/releases?per_page=100"))
    rows = [r for page in pages for r in page if r["tag_name"] == tag]
    assert len(rows) <= 1
    return checked_release(rows[0], tag) if rows else None


def prepare(tag):
    source_guard()
    assert tag == "v" + version()
    r = release(tag)
    if r is None:
        notes = ROOT / "docs/releases" / (tag + ".md")
        body = notes.read_text(encoding="utf-8") if notes.is_file() else "Shell EX " + tag
        # Keep the ID from the authenticated creation response. A fresh draft
        # may not appear immediately in the tag-based or list API.
        r = json.loads(subprocess.check_output(
            ["gh", "api", "--method", "POST", f"repos/{REPO}/releases", "--input", "-"],
            input=json.dumps({
                "tag_name": tag, "target_commitish": SHA,
                "name": "Shell EX " + tag, "body": body,
                "draft": True, "prerelease": False,
            }), text=True, cwd=ROOT
        ))
        r = checked_release(r, tag)
    assert r["draft"], "Refusing to modify an existing published release"
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"release_id={r['id']}\n")
    print("Release draft:", r["html_url"], "source:", SHA)

def asset_name(platform, v):
    return "Shell-EX_" + v + PLATFORMS[platform][2]


def stage(platform):
    source_guard()
    v = version()
    target, pattern, suffix = PLATFORMS[platform]
    packages = list((ROOT / "target" / target / "release/bundle").glob(pattern))
    assert len(packages) == 1, packages
    assert packages[0].name.replace(" ", "-").startswith("Shell-EX_" + v + "_")
    OUT.mkdir(exist_ok=False)
    p = OUT / asset_name(platform, v)
    shutil.copyfile(packages[0], p)
    h = digest(p)[7:]
    (OUT / (p.name + ".sha256")).write_text(h + "  " + p.name + "\n")
    (OUT / (p.name + ".build.json")).write_text(json.dumps({
        "version": v, "sourceCommit": SHA, "target": target, "platform": platform,
        "installer": p.name, "sha256": h,
        "run_url": f"https://github.com/{REPO}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
        "signing": "ad-hoc, not notarized" if suffix.endswith(".dmg") else "unsigned",
    }, indent=2) + "\n")
    print("Staged:", p.name, p.stat().st_size, h)


def upload(tag):
    source_guard()
    r = release(tag)
    assert r and r["draft"]
    files = sorted(OUT.iterdir())
    assert len(files) == 3
    current = {a["name"]: a for a in r["assets"]}
    missing = []
    for p in files:
        if p.name in current:
            assert current[p.name]["state"] == "uploaded"
            assert current[p.name]["digest"] == digest(p)
        else:
            missing.append(str(p))
    if missing:
        gh("release", "upload", tag, "--repo", REPO, *missing)
    current = {a["name"]: a for a in api(f"releases/{r['id']}")["assets"]}
    for p in files:
        a = current[p.name]
        assert a["state"] == "uploaded" and a["size"] == p.stat().st_size
        assert a["digest"] == digest(p)
        print("Verified uploaded asset:", p.name)


def finalize(tag):
    source_guard()
    v = version()
    r = release(tag)
    assert r and r["draft"]
    assets = {a["name"]: a for a in r["assets"]}
    for platform, (target, _, _) in PLATFORMS.items():
        name = asset_name(platform, v)
        names = (name, name + ".sha256", name + ".build.json")
        for n in names:
            assert assets[n]["state"] == "uploaded"
            assert assets[n]["digest"].startswith("sha256:")
        with tempfile.TemporaryDirectory() as temp:
            gh("release", "download", tag, "--repo", REPO, "--dir", temp,
               "--pattern", name + ".sha256", "--pattern", name + ".build.json")
            checksum = pathlib.Path(temp) / names[1]
            manifest = pathlib.Path(temp) / names[2]
            assert digest(checksum) == assets[names[1]]["digest"]
            assert digest(manifest) == assets[names[2]]["digest"]
            h = assets[name]["digest"][7:]
            assert checksum.read_text().strip() == h + "  " + name
            m = json.loads(manifest.read_text())
            assert m["sourceCommit"] == SHA and m["version"] == v and m["target"] == target
            assert m["platform"] == platform and m["installer"] == name and m["sha256"] == h
    gh("release", "edit", tag, "--repo", REPO, "--draft=false", "--latest")
    result = release(tag)
    assert result and not result["draft"] and not result["prerelease"]
    print("Published:", result["html_url"])


def plan():
    source_guard()
    v = version()
    event = json.loads(pathlib.Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    if os.environ["GITHUB_EVENT_NAME"] == "workflow_dispatch":
        requested = str(event.get("inputs", {}).get("publish", "false")).lower() == "true"
    else:
        before = event.get("before", "")
        assert re.fullmatch(r"[0-9a-f]{40}", before)
        old = subprocess.check_output(["git", "show", before + ":apps/desktop/package.json"], cwd=ROOT, text=True)
        requested = json.loads(old)["version"] != v
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"publish={str(requested).lower()}\ntag=v{v}\n")
    print("Release requested:", requested, "version:", v)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plan", "prepare", "stage", "upload", "finalize"])
    parser.add_argument("value", nargs="?")
    args = parser.parse_args()
    if args.command == "plan":
        plan()
    else:
        {"prepare": prepare, "stage": stage, "upload": upload, "finalize": finalize}[args.command](args.value)
