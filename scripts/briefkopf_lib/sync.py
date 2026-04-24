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


def ensure_section_properties(doc: etree._Element, rids: dict[str, str]) -> None:
    """Set titlePg + header/footer refs on the body's final <w:sectPr>.

    Keys in `rids`: first-header, first-footer, default-header, default-footer.
    """
    body = doc.find(f"./{_W}body")
    assert body is not None, "document has no body"
    sect_pr = body.find(f"./{_W}sectPr")
    if sect_pr is None:
        sect_pr = etree.SubElement(body, f"{_W}sectPr")

    keep = [
        el for el in sect_pr
        if el.tag not in (f"{_W}headerReference", f"{_W}footerReference", f"{_W}titlePg")
    ]
    for el in list(sect_pr):
        sect_pr.remove(el)

    _R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

    for typ, rel_key in [("first", "first-header"), ("default", "default-header")]:
        ref = etree.SubElement(sect_pr, f"{_W}headerReference")
        ref.set(f"{_W}type", typ)
        ref.set(f"{_R}id", rids[rel_key])

    for typ, rel_key in [("first", "first-footer"), ("default", "default-footer")]:
        ref = etree.SubElement(sect_pr, f"{_W}footerReference")
        ref.set(f"{_W}type", typ)
        ref.set(f"{_R}id", rids[rel_key])

    for el in keep:
        sect_pr.append(el)

    etree.SubElement(sect_pr, f"{_W}titlePg")


def patch_content_types(target: DocxBundle) -> None:
    """Ensure [Content_Types].xml has overrides for header1/2 + footer1/2."""
    ct = target.read_part("[Content_Types].xml").decode("utf-8")
    overrides = [
        ("/word/header1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"),
        ("/word/header2.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"),
        ("/word/footer1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"),
        ("/word/footer2.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"),
    ]
    for part_name, ctype in overrides:
        if f'PartName="{part_name}"' in ct:
            continue
        insert = f'<Override PartName="{part_name}" ContentType="{ctype}"/>'
        ct = ct.replace("</Types>", insert + "</Types>")
    target.write_part("[Content_Types].xml", ct.encode("utf-8"))


def patch_document_rels(target: DocxBundle) -> dict[str, str]:
    """Ensure document.xml.rels has rIds for header1/2 + footer1/2. Returns rid map."""
    import re

    rels_path = "word/_rels/document.xml.rels"
    if target.has_part(rels_path):
        rels_xml = target.read_part(rels_path).decode("utf-8")
    else:
        rels_xml = (
            '<?xml version="1.0"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            "</Relationships>"
        )

    existing_ids: set[str] = set()
    for m in re.finditer(r'Id="([^"]+)"', rels_xml):
        existing_ids.add(m.group(1))

    def _next_id() -> str:
        i = 100
        while f"rId{i}" in existing_ids:
            i += 1
        existing_ids.add(f"rId{i}")
        return f"rId{i}"

    wanted = [
        ("first-header", "header1.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header"),
        ("first-footer", "footer1.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer"),
        ("default-header", "header2.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header"),
        ("default-footer", "footer2.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer"),
    ]

    rid_map: dict[str, str] = {}
    for key, target_name, rel_type in wanted:
        m = re.search(rf'Id="([^"]+)"[^/]*Target="{target_name}"', rels_xml)
        if m:
            rid_map[key] = m.group(1)
            continue
        new_id = _next_id()
        rel_entry = f'<Relationship Id="{new_id}" Type="{rel_type}" Target="{target_name}"/>'
        rels_xml = rels_xml.replace("</Relationships>", rel_entry + "</Relationships>")
        rid_map[key] = new_id

    target.write_part(rels_path, rels_xml.encode("utf-8"))
    return rid_map
