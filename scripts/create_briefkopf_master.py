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

# Concrete TBS values → FELD_ placeholders. Only applied to paragraphs OUTSIDE
# the sidebar textbox. Order matters: longer keys first so substring containment
# (e.g. "Amtsgericht Trier" inside "Amtsgericht Trier, Az. 23 IN 156/25") is
# resolved correctly. Used to convert a real outgoing letter (Briefkopf_TBS.docx)
# back into a generic template when used as --source.
CONCRETE_TO_FELD: dict[str, str] = {
    # Mein Zeichen — most specific first to win the overlap with "Amtsgericht Trier"
    "Amtsgericht Trier, Az. 23 IN 156/25": "FELD_Mein_Zeichen",
    # Empfänger-Block (top-left framed paragraphs)
    "Justizstraße 2-6": "FELD_Gericht_Adresse",
    "54290 Trier": "FELD_Gericht_PLZ_Ort",
    "Amtsgericht Trier": "FELD_Gericht_Ort",
    # Sachbearbeiter-Block (top-right)
    "RA Ingo Grünewald": "FELD_Sachbearbeiter_Name",
    "0651 / 170 830 - 131": "FELD_Sachbearbeiter_Durchwahl",
    "0651 / 170 830 - 0": "FELD_Standort_Telefon",
    # E-Mail row: source has "Ingo.Gruenewald" + "@tbs-insolvenzverwalter.de"
    # split across two runs. Convention from old Gutachten Muster:
    # FELD_Sachbearbeiter_ + Email → letter-generator joins the two halves.
    "Ingo.Gruenewald": "FELD_Sachbearbeiter_",
    "@tbs-insolvenzverwalter.de": "Email",
    # Ihr Zeichen (after Mein Zeichen replacement consumed the "Az."-bearing line)
    "23 IN 156/25": "FELD_Ihr_Zeichen",
}

# Date paragraph is split across many tiny runs ('1', '4', '.0', '4', '.2026').
# In the TBS source it's a standalone paragraph with text like
# "Trier, den 14.04.2026". The "per beA" line lives in a separate paragraph
# above and stays as static text.
import re as _re
_DATE_LINE_PATTERN = _re.compile(
    r"^([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß \-]*?)(,\s*den\s*)(\d{1,2}\.\d{2}\.\d{4})\s*$"
)
_DATE_LINE_REPLACEMENT = r"FELD_Briefkopf_Ort\2FELD_Briefkopf_Datum"


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
    _replace_concrete_with_feld_in_sdt(body)
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
    """Give every BODY paragraph inside the briefkopf-block SDT explicit line
    spacing + font size, so rendering in target templates doesn't depend on the
    target's Normal-style defaults (which differ between Gutachten and Anschreiben).

    SKIPS paragraphs inside <w:txbxContent> (the floating Sidebar textbox). The
    Sidebar carries its own compact spacing in the source (240/276) — overriding
    it with 1.5x line height makes the partner list overflow vertically and
    cuts off the bottom half of the sidebar (PARTNER list runs past the
    page edge into the footer area).
    """
    LINE = "360"  # 1.5 line spacing (matches Gutachten Normal style)
    SZ = "22"     # 11pt (matches Gutachten Normal style)
    txbx_tag = f"{_W}txbxContent"
    for sdt in body.iter(f"{_W}sdt"):
        tag_el = sdt.find(f".//{_W}tag")
        if tag_el is None or tag_el.get(f"{_W}val") != "briefkopf-block":
            continue
        for p in sdt.iter(f"{_W}p"):
            # Walk ancestors — skip if this paragraph lives inside a textbox
            inside_textbox = False
            ancestor = p.getparent()
            while ancestor is not None:
                if ancestor.tag == txbx_tag:
                    inside_textbox = True
                    break
                ancestor = ancestor.getparent()
            if inside_textbox:
                continue
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


def _replace_concrete_with_feld_in_sdt(body: etree._Element) -> None:
    """Convert concrete TBS values (used in a real outgoing letter) back into
    FELD_ placeholders. Walks paragraphs in the briefkopf-block SDT, skips
    those inside the sidebar textbox (w:txbxContent), and replaces text at
    paragraph level (handles run-splitting via flatten-and-reflow).

    Non-Briefkopf-source DOCX (where text is already FELD_/KI_ placeholders)
    are unaffected because the concrete strings simply don't match.
    """
    txbx_tag = f"{_W}txbxContent"
    drawing_tag = f"{_W}drawing"

    def is_inside(p: etree._Element, target_tag: str) -> bool:
        ancestor = p.getparent()
        while ancestor is not None:
            if ancestor.tag == target_tag:
                return True
            ancestor = ancestor.getparent()
        return False

    for sdt in body.iter(f"{_W}sdt"):
        tag_el = sdt.find(f".//{_W}tag")
        if tag_el is None or tag_el.get(f"{_W}val") != "briefkopf-block":
            continue

        for p in sdt.iter(f"{_W}p"):
            # Skip Sidebar (textbox content) and any drawing-internal paragraphs
            if is_inside(p, txbx_tag) or is_inside(p, drawing_tag):
                continue

            # Get all <w:t> in this paragraph that are NOT inside a drawing
            # (anchors for floating images can sit inside a paragraph)
            ts = []
            for t in p.iter(f"{_W}t"):
                inside_drawing = False
                a = t.getparent()
                while a is not None and a is not p:
                    if a.tag == drawing_tag:
                        inside_drawing = True
                        break
                    a = a.getparent()
                if not inside_drawing:
                    ts.append(t)
            if not ts:
                continue

            full = "".join(t.text or "" for t in ts)
            new = full

            # Apply concrete-to-FELD mapping (longest keys first via dict order)
            for old_text, feld in CONCRETE_TO_FELD.items():
                new = new.replace(old_text, feld)

            # Special-case the per-beA + Ort + Datum line (split across many runs)
            new = _DATE_LINE_PATTERN.sub(_DATE_LINE_REPLACEMENT, new)

            if new == full:
                continue

            # Flatten-and-reflow: write everything into the first <w:t>, blank the rest
            ts[0].text = new
            for t in ts[1:]:
                t.text = ""


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
