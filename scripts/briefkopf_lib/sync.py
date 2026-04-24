"""High-level sync: apply master's briefkopf to a target DocxBundle."""
from __future__ import annotations

from lxml import etree

from .docx_zip import DocxBundle
from .sdt import NS_W, find_sdts_by_tag, replace_sdt

_W = f"{{{NS_W}}}"


BRIEFKOPF_SDT_TAGS = [
    "briefkopf-block",
]


def sync_sdts(target: DocxBundle, master: DocxBundle, tags: list[str]) -> None:
    """Replace each SDT in target's document.xml with the matching one from master.

    If target has no SDT with a given tag, insert a copy from master at the start
    of the body (in order defined by `tags`). This makes first-time sync on
    previously-unprepared templates work without a separate prepare step.

    Image references (r:embed) inside the copied SDTs are remapped to fresh
    non-conflicting rIds in the target's document.xml.rels, so the DEKRA/VID
    siegel images render correctly.

    Raises RuntimeError if master is missing a tag.
    """
    from copy import deepcopy

    target_xml = target.read_part("word/document.xml")
    master_xml = master.read_part("word/document.xml")
    target_doc = etree.fromstring(target_xml)
    master_doc = etree.fromstring(master_xml)

    target_body = target_doc.find(f"./{_W}body")
    assert target_body is not None, "target document has no body"

    # Build image embed remap (master rId → new target rId), ensure target rels
    embed_remap = _ensure_sdt_image_rels(target, master, master_doc, tags)

    # First: remove any existing briefkopf SDTs from target (to re-insert cleanly at top)
    for tag in tags:
        for existing in find_sdts_by_tag(target_doc, tag):
            parent = existing.getparent()
            if parent is not None:
                parent.remove(existing)

    # Single 'briefkopf-block' SDT (whole Gutachten-style briefkopf preamble)
    # placed at body top. Inserts all framed paragraphs, flow spacers, sidebar
    # paragraph (with per beA inline), Ort+Datum line — all in correct order.
    had_any_insert = False
    for position, tag in enumerate(tags):
        master_matches = find_sdts_by_tag(master_doc, tag)
        if not master_matches:
            raise RuntimeError(f"master missing SDT with tag '{tag}'")
        master_sdt = deepcopy(master_matches[0])
        _remap_image_embeds(master_sdt, embed_remap)
        target_body.insert(position, master_sdt)
        had_any_insert = True

    if had_any_insert:
        print(f"  Inserted {len(tags)} briefkopf SDT(s) at body top")

    target.write_part(
        "word/document.xml",
        etree.tostring(target_doc, xml_declaration=True, encoding="UTF-8", standalone=True),
    )


def _ensure_body_top_spacing(body: etree._Element, num_spacers: int) -> None:
    """Insert `num_spacers` empty <w:p/> right after the leading SDT block,
    so the first non-SDT body paragraph starts below the address window
    area rendered by the framed briefkopf-empfaenger block.

    Idempotent: drops any existing empty paragraphs in the same position
    before inserting, so repeat syncs don't pile up spacers.
    """
    first_non_sdt = 0
    for child in body:
        if child.tag == f"{_W}sdt":
            first_non_sdt += 1
        else:
            break

    # Drop existing empty paragraphs directly after the SDT cluster
    while first_non_sdt < len(body):
        child = body[first_non_sdt]
        if child.tag != f"{_W}p":
            break
        has_text = any((t.text or "").strip() for t in child.iter(f"{_W}t"))
        has_drawing = child.find(f".//{_W}drawing") is not None
        if has_text or has_drawing:
            break
        body.remove(child)

    for i in range(num_spacers):
        p = etree.Element(f"{_W}p")
        body.insert(first_non_sdt + i, p)


_NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_R_ATTR = f"{{{_NS_R}}}embed"
_A_BLIP = "{http://schemas.openxmlformats.org/drawingml/2006/main}blip"
_IMAGE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"


def _ensure_sdt_image_rels(
    target: DocxBundle,
    master: DocxBundle,
    master_doc: etree._Element,
    tags: list[str],
) -> dict[str, str]:
    """For each image r:embed used within master's briefkopf SDTs, add a relationship
    in target's document.xml.rels pointing to the (already imported) renamed media
    file. Returns a dict mapping master rId → target rId."""
    import re

    # Which image rIds do the master SDTs use?
    master_embeds: set[str] = set()
    for tag in tags:
        for sdt in find_sdts_by_tag(master_doc, tag):
            for blip in sdt.iter(_A_BLIP):
                rid = blip.get(_R_ATTR)
                if rid:
                    master_embeds.add(rid)

    if not master_embeds:
        return {}

    # Map master rId → media target (e.g., "media/image1.png")
    master_rels_xml = master.read_part("word/_rels/document.xml.rels").decode("utf-8")
    master_rid_to_target: dict[str, str] = {}
    for m in re.finditer(
        r'<Relationship\s+Id="([^"]+)"\s+Type="[^"]*relationships/image"\s+Target="([^"]+)"',
        master_rels_xml,
    ):
        master_rid_to_target[m.group(1)] = m.group(2)

    # Load target rels (or bootstrap empty)
    target_rels_path = "word/_rels/document.xml.rels"
    if target.has_part(target_rels_path):
        target_rels_xml = target.read_part(target_rels_path).decode("utf-8")
    else:
        target_rels_xml = (
            '<?xml version="1.0"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            "</Relationships>"
        )

    existing_ids = {m.group(1) for m in re.finditer(r'Id="([^"]+)"', target_rels_xml)}

    def _next_id() -> str:
        i = 500
        while f"rId{i}" in existing_ids:
            i += 1
        existing_ids.add(f"rId{i}")
        return f"rId{i}"

    remap: dict[str, str] = {}
    for master_rid in sorted(master_embeds):
        master_target = master_rid_to_target.get(master_rid)
        if master_target is None:
            print(f"  WARN: master SDT references {master_rid} but no image relationship found")
            continue
        # Rename to briefkopf_ prefix (consistent with sync_media)
        basename = master_target.split("/")[-1]
        new_target = f"media/briefkopf_{basename}"
        new_rid = _next_id()
        rel_entry = (
            f'<Relationship Id="{new_rid}" '
            f'Type="{_IMAGE_REL_TYPE}" Target="{new_target}"/>'
        )
        target_rels_xml = target_rels_xml.replace(
            "</Relationships>", rel_entry + "</Relationships>"
        )
        remap[master_rid] = new_rid

    target.write_part(target_rels_path, target_rels_xml.encode("utf-8"))
    return remap


def _remap_image_embeds(element: etree._Element, remap: dict[str, str]) -> None:
    """Rewrite r:embed attributes on <a:blip> inside `element` using the remap."""
    for blip in element.iter(_A_BLIP):
        old = blip.get(_R_ATTR)
        if old and old in remap:
            blip.set(_R_ATTR, remap[old])


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

    # Master's convention (from Briefkopf_TBS.docx):
    #   header1.xml = default (page 2+, empty shell)
    #   header2.xml = first (page 1, logo-dekobar)
    #   footer1.xml = default (page 2+, "Seite X von Y")
    #   footer2.xml = first (page 1, logo-dekobar)
    wanted = [
        ("first-header", "header2.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header"),
        ("first-footer", "footer2.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer"),
        ("default-header", "header1.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header"),
        ("default-footer", "footer1.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer"),
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
