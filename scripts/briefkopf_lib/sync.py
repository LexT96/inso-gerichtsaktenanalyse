"""High-level sync: apply master's briefkopf to a target DocxBundle."""
from __future__ import annotations

from lxml import etree

from .docx_zip import DocxBundle
from .sdt import NS_W, find_sdts_by_tag, replace_sdt

_W = f"{{{NS_W}}}"


BRIEFKOPF_SDT_TAGS = [
    "briefkopf-sidebar",
    "briefkopf-siegel-dekra",
    "briefkopf-siegel-vid",
    "briefkopf-sachbearbeiter",
]


def sync_sdts(target: DocxBundle, master: DocxBundle, tags: list[str]) -> None:
    """Replace each SDT in target's document.xml with the matching one from master.

    Raises RuntimeError if master is missing a tag. Logs warning if target is missing.
    """
    target_xml = target.read_part("word/document.xml")
    master_xml = master.read_part("word/document.xml")
    target_doc = etree.fromstring(target_xml)
    master_doc = etree.fromstring(master_xml)

    for tag in tags:
        master_matches = find_sdts_by_tag(master_doc, tag)
        if not master_matches:
            raise RuntimeError(f"master missing SDT with tag '{tag}'")
        master_sdt = master_matches[0]

        target_matches = find_sdts_by_tag(target_doc, tag)
        if not target_matches:
            print(f"  WARN: target has no SDT with tag '{tag}' — skipping")
            continue
        replace_sdt(target_matches[0], master_sdt)

    target.write_part(
        "word/document.xml",
        etree.tostring(target_doc, xml_declaration=True, encoding="UTF-8", standalone=True),
    )
