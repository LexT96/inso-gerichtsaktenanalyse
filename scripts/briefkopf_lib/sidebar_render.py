"""Render the partner sidebar text-box from kanzlei.json.

Ported from scripts/update-briefkopf.legacy.py, adapted to operate on raw
lxml elements inside a DocxBundle (no python-docx dependency).

The sidebar lives as a <w:txbxContent> floating frame inside the
briefkopf-block SDT. We replace its paragraphs with fresh ones built from
kanzlei.json, preserving the existing bold/regular run-properties as
formatting templates so the visual style stays the same.

Word's mc:AlternateContent stores the textbox in TWO places — modern
wps:txbx and VML fallback v:textbox. Both share the same w:txbxContent
tag, so iterating finds both copies and we update them in lock-step.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Literal

from lxml import etree

from .sdt import NS_W

_W = f"{{{NS_W}}}"
_XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

Role = Literal["name", "title", "header", "empty"]


def build_sidebar_lines(data: dict[str, Any]) -> list[tuple[Role, str]]:
    """Build the ordered (role, text) line list to render in the sidebar.

    Roles drive formatting template choice:
      'name'   → bold style (partner name, website)
      'title'  → regular style (titel lines, register text)
      'header' → regular style ("PARTNER", "STANDORTE", ...)
      'empty'  → blank spacer paragraph
    """
    lines: list[tuple[Role, str]] = []
    kanzlei = data["kanzlei"]
    lines.append(("name", kanzlei["website"]))
    lines.append(("title", "Partnerschaftsregister des"))
    lines.append(("title", kanzlei["partnerschaftsregister"]))
    lines.append(("empty", ""))
    lines.append(("empty", ""))

    by_category: dict[str, list[dict[str, Any]]] = {}
    for p in data.get("partner", []):
        by_category.setdefault(p["kategorie"], []).append(p)

    for cat in ["PARTNER", "ANGESTELLTE RECHTSANWÄLTE", "OF COUNSEL"]:
        members = by_category.get(cat)
        if not members:
            continue
        lines.append(("empty", ""))
        lines.append(("header", cat))
        for p in members:
            lines.append(("name", p["name"]))
            for line in (p.get("titel") or "").split("\n"):
                if line:
                    lines.append(("title", line))
            lines.append(("empty", ""))

    lines.append(("empty", ""))
    lines.append(("header", "STANDORTE"))
    standorte = list(data.get("standorte", {}).keys())
    for i in range(0, len(standorte), 2):
        left = standorte[i]
        right = standorte[i + 1] if i + 1 < len(standorte) else ""
        lines.append(("title", f"{left}\t\t{right}"))
    return lines


def find_sidebar_textboxes(scope: etree._Element) -> list[etree._Element]:
    """Return all <w:txbxContent> elements within `scope` whose joined text
    contains 'PARTNER' (the sidebar marker)."""
    found = []
    for tc in scope.iter(f"{_W}txbxContent"):
        text = "".join(t.text or "" for t in tc.iter(f"{_W}t"))
        if "PARTNER" in text:
            found.append(tc)
    return found


def replace_textbox_content(
    txbx_content: etree._Element,
    lines: list[tuple[Role, str]],
) -> None:
    """Replace all <w:p> children of `txbx_content` with paragraphs built
    from `lines`. Existing paragraph + run properties are reused as
    formatting templates (bold = name, regular = title)."""
    paragraphs = txbx_content.findall(f"{_W}p")
    if not paragraphs:
        return

    # Sniff formatting templates: first bold run = name, first non-bold-with-text run = title
    name_ppr = name_rpr = title_ppr = title_rpr = None
    for p in paragraphs:
        ppr = p.find(f"{_W}pPr")
        for r in p.findall(f"{_W}r"):
            rpr = r.find(f"{_W}rPr")
            if rpr is None:
                continue
            is_bold = rpr.find(f"{_W}b") is not None
            if is_bold and name_rpr is None:
                name_rpr = deepcopy(rpr)
                name_ppr = deepcopy(ppr) if ppr is not None else None
            elif not is_bold and title_rpr is None:
                text = "".join(t.text or "" for t in p.iter(f"{_W}t"))
                if text.strip():
                    title_rpr = deepcopy(rpr)
                    title_ppr = deepcopy(ppr) if ppr is not None else None
            if name_rpr is not None and title_rpr is not None:
                break
        if name_rpr is not None and title_rpr is not None:
            break

    if title_rpr is None and name_rpr is not None:
        title_rpr = deepcopy(name_rpr)
        title_ppr = deepcopy(name_ppr) if name_ppr is not None else None
    if name_rpr is None and title_rpr is not None:
        name_rpr = deepcopy(title_rpr)
        name_ppr = deepcopy(title_ppr) if title_ppr is not None else None

    for p in paragraphs:
        txbx_content.remove(p)

    for role, text in lines:
        p = etree.SubElement(txbx_content, f"{_W}p")
        ppr_template = name_ppr if role == "name" else title_ppr
        rpr_template = name_rpr if role == "name" else title_rpr
        if ppr_template is not None:
            p.insert(0, deepcopy(ppr_template))
        r = etree.SubElement(p, f"{_W}r")
        if rpr_template is not None:
            r.insert(0, deepcopy(rpr_template))
        t = etree.SubElement(r, f"{_W}t")
        t.text = text
        t.set(_XML_SPACE, "preserve")


def render_sidebar_in_doc(doc_xml: bytes, kanzlei_data: dict[str, Any]) -> bytes:
    """Find the sidebar text-box(es) in document.xml, replace their content
    with lines built from kanzlei_data. Returns updated XML bytes."""
    doc = etree.fromstring(doc_xml)
    boxes = find_sidebar_textboxes(doc)
    if not boxes:
        return doc_xml
    lines = build_sidebar_lines(kanzlei_data)
    for tc in boxes:
        replace_textbox_content(tc, lines)
    return etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True)
