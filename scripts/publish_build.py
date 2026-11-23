#!/usr/bin/env python3
"""Preserve CI installers and fixture evidence as an unpublished build release."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def gh(*args, check=True):
    return subprocess.run(
        ["gh", *args], check=check, text=True, capture_output=True, cwd=ROOT
    )


def get_release(repo, tag):
    result = gh(
        "release", "view", tag, "--repo", repo,
        "--json", "isDraft,targetCommitish,url", check=False,
    )
    return json.loads(result.stdout) if result.returncode == 0 else None


def draft_release(repo, sha, temp):
    tag = f"build-{sha[:12]}"
    current = get_release(repo, tag)
    if current is None:
        notes = temp / "release-notes.md"
        notes.write_text(
            f"# Shell EX 0.1.0 — build draft\n\n"
            f"Source commit: `{sha}`.\n\n"
            "This unpublished build draft collects installers, SHA-256 checksums, "
            "and UI verification evidence from independent CI jobs. Assets can arrive "
            "at different times; consult each workflow result before installing.\n\n"
            "macOS uses ad-hoc signing (no Developer ID notarization); Windows "
            "does not have an Authenticode certificate. Automatic updates are disabled "
            "until the release signing key and HTTPS manifest are configured.\n\n"
            f"[Build and verification runs](https://github.com/{repo}/actions?query=branch%3Amaster)\n\n"
            f"[Current handoff and verification status](https://github.com/{repo}/blob/master/docs/milestones/STATUS.md)\n",
            encoding="utf-8",
        )
        created = gh(
            "release", "create", tag, "--repo", repo, "--target", sha,
            "--draft", "--prerelease", "--title", f"Shell EX 0.1.0 · {sha[:12]}",
            "--notes-file", str(notes), check=False,
        )
        # Other platform/UI jobs may have created the same draft concurrently.
        current = get_release(repo, tag)
        if current is None:
            raise RuntimeError(f"Could not create build draft: {created.stderr.strip()}")
    if not current["isDraft"] or current["targetCommitish"] != sha:
        raise RuntimeError("Refusing to modify a published release or a different source commit")
    return tag, current["url"]


def screenshots():
    """Small test-fixture PNGs remain reviewable even with Actions artifact quota full."""
    print("::group::UI fixture screenshots (PNG base64)")
    for path in sorted((ROOT / "apps/desktop/test-results").rglob("*.png")):
        if path.name not in {
            "workbench-dark-empty.png", "host-dialog.png", "workbench-dark.png",
            "workbench-light.png", "workbench-compact.png",
        }:
            continue
        if path.stat().st_size > 1_048_576:
            continue
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        print(f"SHELL_EX_SCREENSHOT {path.name} {encoded}", flush=True)
    print("::endgroup::")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=["desktop", "ui", "screenshots"])
    parser.add_argument("--target")
    parser.add_argument("--platform")
    args = parser.parse_args()
    if args.kind == "screenshots":
        screenshots()
        return
    sha = os.environ["GITHUB_SHA"]
    repo = os.environ["GITHUB_REPOSITORY"]
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("Expected a full source commit SHA")
    if os.environ.get("GITHUB_REF") != "refs/heads/master":
        raise RuntimeError("Build draft uploads are restricted to master")
    if not os.environ.get("GH_TOKEN"):
        raise RuntimeError("The build upload step requires its scoped GitHub token")
    stamp = f"r{os.environ['GITHUB_RUN_ID']}.{os.environ.get('GITHUB_RUN_ATTEMPT', '1')}"
    with tempfile.TemporaryDirectory(prefix="shell-ex-build-") as directory:
        temp = Path(directory)
        if args.kind == "desktop":
            if not args.target or not args.platform:
                parser.error("desktop requires --target and --platform")
            bundle = ROOT / "target" / args.target / "release/bundle"
            sources = sorted(
                path for pattern in ("dmg/*.dmg", "nsis/*.exe", "deb/*.deb")
                for path in bundle.glob(pattern)
            )
            if not sources:
                raise RuntimeError("Native build produced no installer")
            label = args.platform
            assets = []
            for source in sources:
                destination = temp / f"{source.stem.replace(' ', '-')}-{stamp}{source.suffix}"
                shutil.copyfile(source, destination)
                assets.append(destination)
        else:
            label = "UI"
            assets = [temp / f"Shell-EX-UI-verification-{stamp}.zip"]
            count = 0
            with zipfile.ZipFile(assets[0], "w", zipfile.ZIP_DEFLATED) as archive:
                for name in ("test-results", "playwright-report"):
                    base = ROOT / "apps/desktop" / name
                    for path in sorted(base.rglob("*")):
                        if path.is_file():
                            archive.write(path, path.relative_to(base.parent))
                            count += 1
            if not count:
                print("No UI report was produced; inspect the failed step log.")
                return
        checksum = temp / f"Shell-EX-{label}-{stamp}.sha256"
        checksum.write_text(
            "".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in assets),
            encoding="utf-8",
        )
        assets.append(checksum)
        manifest = temp / f"Shell-EX-{label}-{stamp}.build.json"
        manifest.write_text(json.dumps({
            "commit": sha, "platform": label, "target": args.target,
            "run_url": f"https://github.com/{repo}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
            "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "1"),
            "assets": [path.name for path in assets],
            "signing": "ad-hoc macOS; unsigned Windows; updater disabled by default",
        }, indent=2) + "\n", encoding="utf-8")
        assets.append(manifest)
        tag, url = draft_release(repo, sha, temp)
        uploaded = gh("release", "upload", tag, "--repo", repo, *map(str, assets), check=False)
        if uploaded.returncode:
            raise RuntimeError(f"Build asset upload failed: {uploaded.stderr.strip()}")
        print(f"Saved {len(assets)} assets to build draft: {url}")
        if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(summary, "a", encoding="utf-8") as output:
                output.write(f"### {label}\n\n[Download build draft]({url}) · source `{sha}`\n\n")
                output.writelines(f"- `{path.name}`\n" for path in assets)


if __name__ == "__main__":
    main()
