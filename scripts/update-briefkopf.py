#!/usr/bin/env python3
"""
Update the partner sidebar in all Gutachten DOCX templates from kanzlei.json.

Usage: python scripts/update-briefkopf.py

Run this script whenever partner/personnel data changes. It reads the
canonical firm data from gutachtenvorlagen/kanzlei.json and updates the
partner sidebar text box in each Gutachten template.
"""

import json
from copy import deepcopy
from pathlib import Path

from docx import Document
from lxml import etree

REPO_ROOT = Path(__file__).resolve().parent.parent
KANZLEI_JSON = REPO_ROOT / "gutachtenvorlagen" / "kanzlei.json"
TEMPLATES_DIR = REPO_ROOT / "gutachtenvorlagen"

TEMPLATE_FILES = [
    "Gutachten Muster natürliche Person.docx",
    "Gutachten Muster juristische Person.docx",
    "Gutachten Muster Personengesellschaft.docx",
]

WP_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WPS_NS = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
XML_NS = "http://www.w3.org/XML/1998/namespace"


def load_kanzlei():
    with open(KANZLEI_JSON, "r", encoding="utf-8") as f:
        return json.load(f)


def build_sidebar_text(data):
    """Build the partner sidebar text from kanzlei.json data."""
    lines = []
    lines.append(data["kanzlei"]["website"])
    lines.append("Partnerschaftsregister des")
    lines.append(data["kanzlei"]["partnerschaftsregister"])
    lines.append("")
    lines.append("")

    # Group partners by category, preserving order
    categories = {}
    for p in data["partner"]:
        cat = p["kategorie"]
        if cat not in categories:
            categories[cat] = []
        categories[cat].append(p)

    for cat_name in ["PARTNER", "ANGESTELLTE RECHTSANWÄLTE", "OF COUNSEL"]:
        if cat_name not in categories:
            continue
        lines.append("")
        lines.append(cat_name)
        for p in categories[cat_name]:
            lines.append(p["name"])
            for title_line in p["titel"].split("\n"):
                lines.append(title_line)
            lines.append("")

    # Standorte (two columns)
    lines.append("")
    lines.append("STANDORTE")
    standorte = list(data["standorte"].keys())
    for i in range(0, len(standorte), 2):
        left = standorte[i]
        right = standorte[i + 1] if i + 1 < len(standorte) else ""
        lines.append(f"{left}\t\t{right}")

    return "\n".join(lines)


VML_NS = "urn:schemas-microsoft-com:vml"


def find_sidebar_textbox(doc):
    """Find the text box containing 'PARTNER' in the document body XML.
    Searches both Word 2010+ (wps:txbxContent) and VML (v:textbox) formats."""
    body = doc.element.body
    # Word 2010+ format
    for txbx in body.iter(f"{{{WPS_NS}}}txbxContent"):
        full_text = "".join(t.text or "" for t in txbx.iter(f"{{{WP_NS}}}t"))
        if "PARTNER" in full_text:
            return txbx
    # VML format (used by Briefkopf templates)
    for txbx in body.iter(f"{{{VML_NS}}}textbox"):
        full_text = "".join(t.text or "" for t in txbx.iter(f"{{{WP_NS}}}t"))
        if "PARTNER" in full_text:
            # Return the w:txbxContent inside the v:textbox
            for content in txbx.iter(f"{{{WP_NS}}}txbxContent"):
                return content
            return txbx
    return None


def replace_textbox_content(txbx_content, new_text):
    """Replace all paragraphs in a textbox with new_text, preserving first paragraph's formatting."""
    paragraphs = txbx_content.findall(f"{{{WP_NS}}}p")
    if not paragraphs:
        return

    # Save first paragraph's run properties as template
    first_rpr = None
    first_ppr = None
    for p in paragraphs:
        ppr = p.find(f"{{{WP_NS}}}pPr")
        if ppr is not None:
            first_ppr = ppr
        for r in p.findall(f"{{{WP_NS}}}r"):
            rpr = r.find(f"{{{WP_NS}}}rPr")
            if rpr is not None:
                first_rpr = rpr
                break
        if first_rpr is not None:
            break

    # Remove all existing paragraphs
    for p in paragraphs:
        txbx_content.remove(p)

    # Add new paragraphs
    for line in new_text.split("\n"):
        p = etree.SubElement(txbx_content, f"{{{WP_NS}}}p")
        if first_ppr is not None:
            p.insert(0, deepcopy(first_ppr))
        r = etree.SubElement(p, f"{{{WP_NS}}}r")
        if first_rpr is not None:
            r.insert(0, deepcopy(first_rpr))
        t = etree.SubElement(r, f"{{{WP_NS}}}t")
        t.text = line
        t.set(f"{{{XML_NS}}}space", "preserve")


def main():
    data = load_kanzlei()
    sidebar_text = build_sidebar_text(data)
    print(f"Generated sidebar text ({len(sidebar_text)} chars)")

    updated = 0
    for template_name in TEMPLATE_FILES:
        template_path = TEMPLATES_DIR / template_name
        if not template_path.exists():
            print(f"  SKIP: {template_name} not found")
            continue

        doc = Document(str(template_path))
        txbx = find_sidebar_textbox(doc)
        if txbx is None:
            print(f"  WARN: No partner sidebar text box found in {template_name}")
            continue

        replace_textbox_content(txbx, sidebar_text)
        doc.save(str(template_path))
        print(f"  OK: Updated {template_name}")
        updated += 1

    print(f"\nDone. Updated {updated}/{len(TEMPLATE_FILES)} templates.")


if __name__ == "__main__":
    main()
