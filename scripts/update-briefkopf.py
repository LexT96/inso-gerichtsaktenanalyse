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


def build_sidebar_lines(data):
    """Build structured sidebar lines with role info for formatting.
    Roles: 'name' (bold), 'title' (regular), 'header' (regular), 'empty' (spacer)"""
    lines = []
    lines.append(("name", data["kanzlei"]["website"]))
    lines.append(("title", "Partnerschaftsregister des"))
    lines.append(("title", data["kanzlei"]["partnerschaftsregister"]))
    lines.append(("empty", ""))
    lines.append(("empty", ""))

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
        lines.append(("empty", ""))
        lines.append(("header", cat_name))
        for p in categories[cat_name]:
            lines.append(("name", p["name"]))
            for title_line in p["titel"].split("\n"):
                lines.append(("title", title_line))
            lines.append(("empty", ""))

    # Standorte (two columns)
    lines.append(("empty", ""))
    lines.append(("header", "STANDORTE"))
    standorte = list(data["standorte"].keys())
    for i in range(0, len(standorte), 2):
        left = standorte[i]
        right = standorte[i + 1] if i + 1 < len(standorte) else ""
        lines.append(("title", f"{left}\t\t{right}"))

    return lines


VML_NS = "urn:schemas-microsoft-com:vml"


def find_all_sidebar_textboxes(doc):
    """Find ALL text boxes/containers containing 'PARTNER' in the document.
    Word uses mc:AlternateContent with both a modern (wps:txbx → w:txbxContent)
    and fallback (v:textbox → w:txbxContent) copy. We must update ALL copies."""
    body = doc.element.body
    found = []
    # Find ALL w:txbxContent elements (both modern wps and VML share this tag)
    for txbx_content in body.iter(f"{{{WP_NS}}}txbxContent"):
        full_text = "".join(t.text or "" for t in txbx_content.iter(f"{{{WP_NS}}}t"))
        if "PARTNER" in full_text:
            # Determine parent type for logging
            parent_tag = txbx_content.getparent().tag if txbx_content.getparent() is not None else "?"
            fmt = "wps" if "wordprocessingShape" in parent_tag else "vml" if "textbox" in parent_tag.lower() else "unknown"
            found.append((fmt, txbx_content))
    return found


def replace_textbox_content(txbx_content, lines):
    """Replace all paragraphs in a textbox with structured lines, preserving formatting.
    Extracts bold (name) and regular (title) formatting templates from existing content."""
    paragraphs = txbx_content.findall(f"{{{WP_NS}}}p")
    if not paragraphs:
        return

    # Extract formatting templates from existing paragraphs:
    # - name_ppr/name_rpr: from first bold paragraph (names)
    # - title_ppr/title_rpr: from first non-bold, non-empty paragraph (titles)
    name_ppr = name_rpr = title_ppr = title_rpr = None
    for p in paragraphs:
        ppr = p.find(f"{{{WP_NS}}}pPr")
        for r in p.findall(f"{{{WP_NS}}}r"):
            rpr = r.find(f"{{{WP_NS}}}rPr")
            if rpr is None:
                continue
            is_bold = rpr.find(f"{{{WP_NS}}}b") is not None
            if is_bold and name_rpr is None:
                name_rpr = deepcopy(rpr)
                name_ppr = deepcopy(ppr) if ppr is not None else None
            elif not is_bold and title_rpr is None:
                text = "".join(t.text or "" for t in p.iter(f"{{{WP_NS}}}t"))
                if text.strip():
                    title_rpr = deepcopy(rpr)
                    title_ppr = deepcopy(ppr) if ppr is not None else None
            if name_rpr and title_rpr:
                break
        if name_rpr and title_rpr:
            break

    # Fallback: use whatever we found
    if title_rpr is None:
        title_rpr = deepcopy(name_rpr) if name_rpr else None
        title_ppr = deepcopy(name_ppr) if name_ppr else None
    if name_rpr is None:
        name_rpr = deepcopy(title_rpr) if title_rpr else None
        name_ppr = deepcopy(title_ppr) if title_ppr else None

    # Remove all existing paragraphs
    for p in paragraphs:
        txbx_content.remove(p)

    # Add new paragraphs with role-appropriate formatting
    for role, text in lines:
        p = etree.SubElement(txbx_content, f"{{{WP_NS}}}p")
        if role == "name":
            if name_ppr is not None:
                p.insert(0, deepcopy(name_ppr))
            rpr_template = name_rpr
        else:
            if title_ppr is not None:
                p.insert(0, deepcopy(title_ppr))
            rpr_template = title_rpr

        r = etree.SubElement(p, f"{{{WP_NS}}}r")
        if rpr_template is not None:
            r.insert(0, deepcopy(rpr_template))
        t = etree.SubElement(r, f"{{{WP_NS}}}t")
        t.text = text
        t.set(f"{{{XML_NS}}}space", "preserve")


def main():
    data = load_kanzlei()
    sidebar_lines = build_sidebar_lines(data)
    print(f"Generated sidebar ({len(sidebar_lines)} lines, {sum(1 for r, _ in sidebar_lines if r == 'name')} names)")

    updated = 0
    for template_name in TEMPLATE_FILES:
        template_path = TEMPLATES_DIR / template_name
        if not template_path.exists():
            print(f"  SKIP: {template_name} not found")
            continue

        doc = Document(str(template_path))
        boxes = find_all_sidebar_textboxes(doc)
        if not boxes:
            print(f"  WARN: No partner sidebar text box found in {template_name}")
            continue

        for fmt, txbx in boxes:
            replace_textbox_content(txbx, sidebar_lines)
        print(f"    ({len(boxes)} text box copies updated: {', '.join(f for f, _ in boxes)})")
        doc.save(str(template_path))
        print(f"  OK: Updated {template_name}")
        updated += 1

    print(f"\nDone. Updated {updated}/{len(TEMPLATE_FILES)} templates.")


if __name__ == "__main__":
    main()
