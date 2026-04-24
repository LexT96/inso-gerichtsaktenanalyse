"""Find and replace <w:sdt> (Structured Document Tag) blocks by tag value."""
from __future__ import annotations

from copy import deepcopy
from lxml import etree

NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_W = f"{{{NS_W}}}"


def find_sdts_by_tag(root: etree._Element, tag_value: str) -> list[etree._Element]:
    """Return all <w:sdt> elements with <w:sdtPr><w:tag w:val="{tag_value}"/>."""
    results: list[etree._Element] = []
    for sdt in root.iter(f"{_W}sdt"):
        tag_el = sdt.find(f"./{_W}sdtPr/{_W}tag")
        if tag_el is not None and tag_el.get(f"{_W}val") == tag_value:
            results.append(sdt)
    return results


def replace_sdt(target_sdt: etree._Element, source_sdt: etree._Element) -> None:
    """Replace `target_sdt` in its parent with a deep copy of `source_sdt`."""
    parent = target_sdt.getparent()
    if parent is None:
        raise ValueError("SDT has no parent — cannot replace")
    index = list(parent).index(target_sdt)
    replacement = deepcopy(source_sdt)
    parent.remove(target_sdt)
    parent.insert(index, replacement)
