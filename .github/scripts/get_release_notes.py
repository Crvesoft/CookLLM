#!/usr/bin/env python3
"""Extract release notes for a version from CHANGELOG.md or README.md.

Usage:
    python get_release_notes.py --version X.Y.Z [--file <path>]

Looks for a heading like "## v1.2.3" or "### v1.2.3" in CHANGELOG.md
(or the file given via --file, falling back to README.md) and prints the
heading together with its body to stdout.

Exits with status 1 when the section is missing or empty, so the release
workflow fails loudly instead of publishing a release without changelog.
(This happened once for v0.1.4 and the in-app updater showed a generic
"no changelog" message.)
"""

import argparse
import re
import sys

# Force UTF-8 for stdout/stderr so notes.md is UTF-8 on every platform
# (Windows consoles default to GBK and would corrupt the changelog).
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


class NotesNotFoundError(Exception):
    pass


def find_source_file(explicit_path):
    if explicit_path:
        return explicit_path
    for candidate in ("CHANGELOG.md", "README.md"):
        try:
            with open(candidate, "r", encoding="utf-8"):
                return candidate
        except FileNotFoundError:
            continue
    raise NotesNotFoundError("neither CHANGELOG.md nor README.md exists in repo root")


def extract_notes(text, version):
    heading = re.compile(
        r"^(#{2,3})\s+[vV]?%s(?:\s|$)" % re.escape(version), re.MULTILINE
    )
    match = heading.search(text)
    if not match:
        raise NotesNotFoundError(
            "no '## v%s' or '### v%s' heading found" % (version, version)
        )

    section_end = match.end()
    next_heading = re.compile(r"^(#{2,3})\s", re.MULTILINE)
    next_match = next_heading.search(text, section_end)
    end = next_match.start() if next_match else len(text)

    notes = text[match.start():end].rstrip() + "\n"
    if not notes.strip() or notes.strip() == "---":
        raise NotesNotFoundError(
            "section for v%s is empty; add changelog entries" % version
        )
    return notes


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="version like 1.2.3")
    parser.add_argument(
        "--file",
        default=None,
        help="notes file (default: CHANGELOG.md, then README.md)",
    )
    args = parser.parse_args(argv)
    try:
        source = find_source_file(args.file)
        with open(source, "r", encoding="utf-8") as fh:
            text = fh.read()
        notes = extract_notes(text, args.version)
    except NotesNotFoundError as exc:
        sys.stderr.write("get_release_notes.py: error: %s\n" % exc)
        return 1
    sys.stdout.write(notes)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))