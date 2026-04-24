#!/usr/bin/env python3
"""
Propagate the master briefkopf (header, footer, partner sidebar, sachbearbeiter)
into target templates via SDT-scoped body replacement + full header/footer swap.

Spec: docs/superpowers/specs/2026-04-24-briefkopf-unified-design.md
Plan: docs/superpowers/plans/2026-04-24-briefkopf-unified.md

Usage:
    python scripts/update-briefkopf.py --template Bankenanfrage
    python scripts/update-briefkopf.py --only anschreiben
    python scripts/update-briefkopf.py --only gutachten
    python scripts/update-briefkopf.py --all
    python scripts/update-briefkopf.py --all --dry-run
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from lxml import etree

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from scripts.briefkopf_lib.docx_zip import DocxBundle  # noqa: E402
from scripts.briefkopf_lib.sync import (  # noqa: E402
    BRIEFKOPF_SDT_TAGS,
    ensure_section_properties,
    patch_content_types,
    patch_document_rels,
    sync_header_footer,
    sync_media,
    sync_sdts,
)

MASTER_PATH = REPO / "briefkopf" / "briefkopf-master.docx"

GUTACHTEN_DIR = REPO / "gutachtenvorlagen"
ANSCHREIBEN_DIR = REPO / "standardschreiben" / "templates"

GUTACHTEN_TEMPLATES = [
    "Gutachten Muster natürliche Person.docx",
    "Gutachten Muster juristische Person.docx",
    "Gutachten Muster Personengesellschaft.docx",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true")
    g.add_argument("--only", choices=["gutachten", "anschreiben"])
    g.add_argument("--template", type=str, help="basename without .docx")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def resolve_targets(args: argparse.Namespace) -> list[Path]:
    gutachten = [GUTACHTEN_DIR / n for n in GUTACHTEN_TEMPLATES]
    anschreiben = sorted(ANSCHREIBEN_DIR.glob("*.docx"))
    if args.all:
        return gutachten + anschreiben
    if args.only == "gutachten":
        return gutachten
    if args.only == "anschreiben":
        return anschreiben
    if args.template:
        for p in gutachten + anschreiben:
            if p.stem == args.template:
                return [p]
        raise SystemExit(f"template not found: {args.template}")
    raise SystemExit("must pass --all or --only or --template")


def sync_template(target_path: Path, master: DocxBundle, dry_run: bool) -> None:
    print(f"\n→ {target_path.relative_to(REPO)}")
    if not target_path.exists():
        print("  SKIP: file missing")
        return
    target = DocxBundle.read(target_path)

    sync_sdts(target, master, BRIEFKOPF_SDT_TAGS)
    sync_header_footer(target, master)
    sync_media(target, master)
    patch_content_types(target)
    rid_map = patch_document_rels(target)

    doc = etree.fromstring(target.read_part("word/document.xml"))
    ensure_section_properties(doc, rid_map)
    target.write_part(
        "word/document.xml",
        etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True),
    )

    if dry_run:
        print("  [dry-run] would write")
        return

    backup = target_path.with_suffix(".backup.docx")
    if not backup.exists():
        backup.write_bytes(target_path.read_bytes())
        print(f"  backup → {backup.name}")

    target.save(target_path)
    print("  ✓ synced")


def main() -> None:
    args = parse_args()
    if not MASTER_PATH.exists():
        raise SystemExit(
            f"master not found: {MASTER_PATH}\n"
            f"Run `python scripts/create_briefkopf_master.py` first."
        )
    master = DocxBundle.read(MASTER_PATH)

    for t in resolve_targets(args):
        sync_template(t, master, args.dry_run)


if __name__ == "__main__":
    main()
