#!/usr/bin/env python3
"""
Create briefkopf/briefkopf-master.docx from a Gutachten-Muster template.

The Gutachten Muster (natürliche Person) already has the correct Briefkopf
layout: framed Empfänger + Sachbearbeiter block (top-left/right), floating
Sidebar + Siegel, Ort+Datum line, then the body ("Gutachten" title).

We take body paragraphs [0..n-1] (everything BEFORE the "Gutachten" title)
as the briefkopf block, wrap them in a single <w:sdt w:tag="briefkopf-block">,
and write the result as briefkopf/briefkopf-master.docx.

KI_* placeholders are renamed to FELD_* in the wrapped content so the
Letter-Generator (which only handles FELD_*) can fill / strip them at
letter generation time.

Usage:
    python scripts/create_briefkopf_master.py \\
        --source gutachtenvorlagen/"Gutachten Muster natürliche Person.docx" \\
        --output briefkopf/briefkopf-master.docx
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from lxml import etree

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from scripts.briefkopf_lib.docx_zip import DocxBundle  # noqa: E402
from scripts.briefkopf_lib.sdt import NS_W  # noqa: E402

_W = f"{{{NS_W}}}"

# Paragraphs whose text exactly matches any of these are treated as the
# start-of-body marker — everything BEFORE is the briefkopf block.
BODY_START_MARKERS = ("Gutachten",)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    source = args.source.expanduser()
    bundle = DocxBundle.read(source)

    doc = etree.fromstring(bundle.read_part("word/document.xml"))
    body = doc.find(f"./{_W}body")
    assert body is not None, "document has no body"

    split_index = _find_body_start_index(body)
    print(f"Briefkopf spans paragraphs [0..{split_index - 1}] "
          f"(body continues at [{split_index}])")

    wrap_as_briefkopf_block(body, split_index)
    _rename_ki_to_feld_in_sdt(body)
    _enforce_explicit_spacing_in_sdt(body)

    _strip_body_after_briefkopf(body)

    new_xml = etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True)
    bundle.write_part("word/document.xml", new_xml)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    bundle.save(args.output)
    print(f"Wrote {args.output}")


def _find_body_start_index(body: etree._Element) -> int:
    """Return the index of the first body child that marks body-content start
    (a non-briefkopf paragraph). Identification: paragraph whose concatenated
    text exactly matches a BODY_START_MARKER (typically the "Gutachten" title)."""
    for i, child in enumerate(body):
        if child.tag != f"{_W}p":
            continue
        runs_in_drawing = set()
        for d in child.iter(f"{_W}drawing"):
            for t in d.iter(f"{_W}t"):
                runs_in_drawing.add(id(t))
        text = "".join(
            t.text or "" for t in child.iter(f"{_W}t") if id(t) not in runs_in_drawing
        ).strip()
        if text in BODY_START_MARKERS:
            return i
    raise RuntimeError(
        f"no body-start marker found in Gutachten source "
        f"(looked for {BODY_START_MARKERS})"
    )


def wrap_as_briefkopf_block(body: etree._Element, split_index: int) -> None:
    """Move body[0..split_index-1] into a single briefkopf-block SDT at body[0]."""
    if split_index == 0:
        return
    moved = list(body)[:split_index]
    insert_idx = list(body).index(moved[0])

    sdt = etree.Element(f"{_W}sdt")
    sdt_pr = etree.SubElement(sdt, f"{_W}sdtPr")
    tag_el = etree.SubElement(sdt_pr, f"{_W}tag")
    tag_el.set(f"{_W}val", "briefkopf-block")
    sdt_content = etree.SubElement(sdt, f"{_W}sdtContent")

    for p in moved:
        body.remove(p)
        sdt_content.append(p)
    body.insert(insert_idx, sdt)


def _enforce_explicit_spacing_in_sdt(body: etree._Element) -> None:
    """Give every paragraph inside the briefkopf-block SDT explicit line spacing
    + font size, so rendering in target templates doesn't depend on the target's
    Normal-style defaults (which differ between Gutachten and Anschreiben)."""
    LINE = "360"  # 1.5 line spacing (matches Gutachten Normal style)
    SZ = "22"     # 11pt (matches Gutachten Normal style)
    for sdt in body.iter(f"{_W}sdt"):
        tag_el = sdt.find(f".//{_W}tag")
        if tag_el is None or tag_el.get(f"{_W}val") != "briefkopf-block":
            continue
        for p in sdt.iter(f"{_W}p"):
            pPr = p.find(f"{_W}pPr")
            if pPr is None:
                pPr = etree.Element(f"{_W}pPr")
                p.insert(0, pPr)
            spacing = pPr.find(f"{_W}spacing")
            if spacing is None:
                spacing = etree.SubElement(pPr, f"{_W}spacing")
            spacing.set(f"{_W}line", LINE)
            spacing.set(f"{_W}lineRule", "auto")
            # Also force font size on paragraph-level rPr default
            ppr_rpr = pPr.find(f"{_W}rPr")
            if ppr_rpr is None:
                ppr_rpr = etree.SubElement(pPr, f"{_W}rPr")
            sz = ppr_rpr.find(f"{_W}sz")
            if sz is None:
                sz = etree.SubElement(ppr_rpr, f"{_W}sz")
            sz.set(f"{_W}val", SZ)


def _rename_ki_to_feld_in_sdt(body: etree._Element) -> None:
    """Replace KI_<identifier> with FELD_<identifier> in all text runs
    inside the briefkopf-block SDT."""
    for sdt in body.iter(f"{_W}sdt"):
        tag_el = sdt.find(f".//{_W}tag")
        if tag_el is None or tag_el.get(f"{_W}val") != "briefkopf-block":
            continue
        for t in sdt.iter(f"{_W}t"):
            if t.text and "KI_" in t.text:
                t.text = re.sub(r"\bKI_", "FELD_", t.text)


def _strip_body_after_briefkopf(body: etree._Element) -> None:
    """Drop everything after the briefkopf-block SDT (Gutachten body content).

    The master should only contain the briefkopf as SDT; the rest of the
    Gutachten body is irrelevant for syncing to Anschreiben templates.
    The body-final <w:sectPr> is kept.
    """
    # Find the briefkopf-block SDT
    briefkopf_idx = None
    for i, child in enumerate(body):
        if child.tag != f"{_W}sdt":
            continue
        tag_el = child.find(f".//{_W}tag")
        if tag_el is not None and tag_el.get(f"{_W}val") == "briefkopf-block":
            briefkopf_idx = i
            break
    if briefkopf_idx is None:
        return
    # Remove all children after the briefkopf SDT EXCEPT the final sectPr
    to_remove = []
    for i, child in enumerate(list(body)):
        if i <= briefkopf_idx:
            continue
        if child.tag == f"{_W}sectPr":
            continue
        to_remove.append(child)
    for child in to_remove:
        body.remove(child)


if __name__ == "__main__":
    main()
