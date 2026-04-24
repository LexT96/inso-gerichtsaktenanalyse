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


HEADER_FOOTER_PARTS = ["header1.xml", "header2.xml", "footer1.xml", "footer2.xml"]


def sync_header_footer(target: DocxBundle, master: DocxBundle) -> None:
    """Copy header1/2 + footer1/2 XMLs and their rels from master."""
    for base in HEADER_FOOTER_PARTS:
        part = f"word/{base}"
        rels = f"word/_rels/{base}.rels"
        if target.has_part(part):
            target.delete_part(part)
        if target.has_part(rels):
            target.delete_part(rels)
        if master.has_part(part):
            target.write_part(part, master.read_part(part))
        if master.has_part(rels):
            target.write_part(rels, master.read_part(rels))


def sync_media(target: DocxBundle, master: DocxBundle) -> None:
    """Import master's media under briefkopf_-prefixed names; patch header/footer rels."""
    master_media_names = [
        name for name in master.list_parts() if name.startswith("word/media/")
    ]
    name_map: dict[str, str] = {}

    for old in master_media_names:
        basename = old.split("/")[-1]
        new_name = f"word/media/briefkopf_{basename}"
        name_map[f"media/{basename}"] = f"media/briefkopf_{basename}"
        target.write_part(new_name, master.read_part(old))

    for base in HEADER_FOOTER_PARTS:
        rels_part = f"word/_rels/{base}.rels"
        if not target.has_part(rels_part):
            continue
        rels_xml = target.read_part(rels_part).decode("utf-8")
        for old, new in name_map.items():
            rels_xml = rels_xml.replace(f'Target="{old}"', f'Target="{new}"')
        target.write_part(rels_part, rels_xml.encode("utf-8"))
