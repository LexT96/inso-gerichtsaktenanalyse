#!/usr/bin/env python3
"""
One-shot: erzeuge `briefkopf/briefkopf-master.docx` aus `/Users/thorsten/Downloads/Briefkopf_TBS.docx`.

Wrapt die 4 Body-Briefkopf-Elemente in <w:sdt> Content Controls mit stabilen Tags,
entfernt Beispiel-Empfänger-Paragraphen. Header/Footer/Media bleiben unverändert.

Usage:
    python scripts/create_briefkopf_master.py \\
        --source ~/Downloads/Briefkopf_TBS.docx \\
        --output briefkopf/briefkopf-master.docx
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from lxml import etree

# Make `scripts.briefkopf_lib.*` importable when running this script directly.
REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from scripts.briefkopf_lib.docx_zip import DocxBundle  # noqa: E402
from scripts.briefkopf_lib.sdt import NS_W  # noqa: E402

_W = f"{{{NS_W}}}"
NS_WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
_WP = f"{{{NS_WP}}}"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_A = f"{{{NS_A}}}"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_R = f"{{{NS_R}}}"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    source = args.source.expanduser()
    bundle = DocxBundle.read(source)
    doc_xml = bundle.read_part("word/document.xml")
    doc = etree.fromstring(doc_xml)

    body = doc.find(f"./{_W}body")
    assert body is not None, "document.xml has no body"

    wrap_empfaenger_block(body)
    wrap_briefkopf_floating_anchors(body)
    wrap_sachbearbeiter_block(body)

    new_xml = etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True)
    bundle.write_part("word/document.xml", new_xml)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    bundle.save(args.output)
    print(f"Wrote {args.output}")


def wrap_briefkopf_floating_anchors(body: etree._Element) -> None:
    """Wrap the 3 body-anchored floating elements (sidebar + 2 siegel) in SDTs.

    Identification (from spec-time inspection of Briefkopf_TBS.docx):
      - Sidebar: wp:extent cx > 1500000 EMU (~4cm+), no blip embed
      - DEKRA:   cx ≈ 432000 EMU, blip embed="rId8" → image1.png
      - VID:     cx ≈ 576000 EMU, blip embed="rId9" → image2.jpeg
    """
    anchors = list(body.iter(f"{_WP}anchor"))

    sidebar_anchor = None
    siegel_dekra = None
    siegel_vid = None
    for a in anchors:
        extent = a.find(f"{_WP}extent")
        if extent is None:
            continue
        cx = int(extent.get("cx", "0"))
        blip = a.find(f".//{_A}blip")
        embed = blip.get(f"{_R}embed") if blip is not None else None

        if cx > 1500000:
            sidebar_anchor = a
        elif embed == "rId8":
            siegel_dekra = a
        elif embed == "rId9":
            siegel_vid = a

    for anchor, tag in [
        (sidebar_anchor, "briefkopf-sidebar"),
        (siegel_dekra, "briefkopf-siegel-dekra"),
        (siegel_vid, "briefkopf-siegel-vid"),
    ]:
        if anchor is None:
            raise RuntimeError(f"anchor for {tag} not found in master body")
        _wrap_paragraph_in_sdt(anchor, tag)


def _wrap_paragraph_in_sdt(anchor: etree._Element, tag: str) -> None:
    """Enclose the <w:p> containing `anchor` in a new <w:sdt> with the given tag."""
    # anchor sits in: <w:p><w:r><w:drawing><wp:anchor>...
    # Walk up to the enclosing <w:p>
    paragraph = anchor
    while paragraph is not None and paragraph.tag != f"{_W}p":
        paragraph = paragraph.getparent()
    if paragraph is None:
        raise RuntimeError(f"no enclosing <w:p> for {tag}")
    parent = paragraph.getparent()
    if parent is None:
        raise RuntimeError(f"paragraph has no parent for {tag}")
    idx = list(parent).index(paragraph)

    sdt = etree.Element(f"{_W}sdt")
    sdt_pr = etree.SubElement(sdt, f"{_W}sdtPr")
    tag_el = etree.SubElement(sdt_pr, f"{_W}tag")
    tag_el.set(f"{_W}val", tag)
    sdt_content = etree.SubElement(sdt, f"{_W}sdtContent")

    parent.remove(paragraph)
    sdt_content.append(paragraph)
    parent.insert(idx, sdt)


def wrap_empfaenger_block(body: etree._Element) -> None:
    """Wrap the recipient-address paragraphs ('Amtsgericht Trier / Justizstraße
    2-6 / 54290 Trier') in a briefkopf-empfaenger SDT.

    The block spans from the first body paragraph up to (but not including)
    the Absenderzeile ('Prof. Dr. Dr. Thomas B. Schmidt ...').
    """
    paragraphs = list(body.findall(f"./{_W}p"))
    absender_idx = None
    for i, p in enumerate(paragraphs):
        text = "".join(t.text or "" for t in p.iter(f"{_W}t"))
        if "Prof. Dr. Dr. Thomas B. Schmidt" in text:
            absender_idx = i
            break
    if absender_idx is None or absender_idx == 0:
        return

    target_range = paragraphs[:absender_idx]
    insert_idx = list(body).index(target_range[0])

    sdt = etree.Element(f"{_W}sdt")
    sdt_pr = etree.SubElement(sdt, f"{_W}sdtPr")
    tag_el = etree.SubElement(sdt_pr, f"{_W}tag")
    tag_el.set(f"{_W}val", "briefkopf-empfaenger")
    sdt_content = etree.SubElement(sdt, f"{_W}sdtContent")

    for p in target_range:
        body.remove(p)
        sdt_content.append(p)
    body.insert(insert_idx, sdt)


def wrap_sachbearbeiter_block(body: etree._Element) -> None:
    """Wrap paragraphs from 'Prof. Dr. Dr. ...' through 'Ihr Zeichen ...' in a SDT."""
    paragraphs = list(body.findall(f"./{_W}p"))
    start_idx = end_idx = None
    for i, p in enumerate(paragraphs):
        text = "".join(t.text or "" for t in p.iter(f"{_W}t"))
        if start_idx is None and "Prof. Dr. Dr. Thomas B. Schmidt" in text:
            start_idx = i
        if start_idx is not None and "Ihr Zeichen" in text:
            end_idx = i
            break
    if start_idx is None or end_idx is None:
        raise RuntimeError(
            f"Sachbearbeiter paragraph range not found "
            f"(start={start_idx}, end={end_idx})"
        )

    target_range = paragraphs[start_idx : end_idx + 1]
    insert_idx = list(body).index(target_range[0])

    sdt = etree.Element(f"{_W}sdt")
    sdt_pr = etree.SubElement(sdt, f"{_W}sdtPr")
    tag_el = etree.SubElement(sdt_pr, f"{_W}tag")
    tag_el.set(f"{_W}val", "briefkopf-sachbearbeiter")
    sdt_content = etree.SubElement(sdt, f"{_W}sdtContent")

    for p in target_range:
        body.remove(p)
        sdt_content.append(p)
    body.insert(insert_idx, sdt)


if __name__ == "__main__":
    main()
