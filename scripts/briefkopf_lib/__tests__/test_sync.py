"""Integration tests for high-level briefkopf sync operations."""
from pathlib import Path
import zipfile

from lxml import etree

from scripts.briefkopf_lib.docx_zip import DocxBundle
from scripts.briefkopf_lib.sync import sync_sdts


def _make_docx_with_sdts(path: Path, sidebar_text: str, body_text: str) -> None:
    doc = (
        '<?xml version="1.0"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>"
        "<w:sdt>"
        '<w:sdtPr><w:tag w:val="briefkopf-sidebar"/></w:sdtPr>'
        f"<w:sdtContent><w:p><w:r><w:t>{sidebar_text}</w:t></w:r></w:p></w:sdtContent>"
        "</w:sdt>"
        f"<w:p><w:r><w:t>{body_text}</w:t></w:r></w:p>"
        "</w:body>"
        "</w:document>"
    )
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>",
        )
        z.writestr("word/document.xml", doc)


def test_sync_sdts_replaces_sdt_content_but_keeps_body(tmp_path: Path) -> None:
    master_path = tmp_path / "master.docx"
    target_path = tmp_path / "target.docx"
    _make_docx_with_sdts(master_path, sidebar_text="NEW master content", body_text="ignored")
    _make_docx_with_sdts(target_path, sidebar_text="OLD target", body_text="SHOULD SURVIVE")

    master = DocxBundle.read(master_path)
    target = DocxBundle.read(target_path)

    sync_sdts(target, master, tags=["briefkopf-sidebar"])

    target.save(target_path)
    reread = DocxBundle.read(target_path)
    doc_xml = reread.read_part("word/document.xml").decode("utf-8")

    assert "NEW master content" in doc_xml
    assert "OLD target" not in doc_xml
    assert "SHOULD SURVIVE" in doc_xml


def test_sync_sdts_raises_when_master_missing_tag(tmp_path: Path) -> None:
    import pytest

    master_path = tmp_path / "master.docx"
    target_path = tmp_path / "target.docx"
    _make_docx_with_sdts(master_path, sidebar_text="M", body_text="m")
    _make_docx_with_sdts(target_path, sidebar_text="T", body_text="t")

    master = DocxBundle.read(master_path)
    target = DocxBundle.read(target_path)

    with pytest.raises(RuntimeError, match="missing SDT"):
        sync_sdts(target, master, tags=["briefkopf-nonexistent"])


def test_sync_header_footer_copies_parts_from_master(tmp_path: Path) -> None:
    master_path = tmp_path / "master.docx"
    target_path = tmp_path / "target.docx"

    with zipfile.ZipFile(master_path, "w") as z:
        z.writestr("[Content_Types].xml", "<x/>")
        z.writestr("_rels/.rels", "<x/>")
        z.writestr("word/document.xml", "<x/>")
        z.writestr("word/header1.xml", "<header>from master</header>")
        z.writestr("word/_rels/header1.xml.rels", "<x/>")
        z.writestr("word/footer1.xml", "<footer>from master</footer>")
        z.writestr("word/_rels/footer1.xml.rels", "<x/>")

    with zipfile.ZipFile(target_path, "w") as z:
        z.writestr("[Content_Types].xml", "<x/>")
        z.writestr("_rels/.rels", "<x/>")
        z.writestr("word/document.xml", "<x/>")

    from scripts.briefkopf_lib.sync import sync_header_footer

    target = DocxBundle.read(target_path)
    master = DocxBundle.read(master_path)
    sync_header_footer(target, master)
    target.save(target_path)

    reread = DocxBundle.read(target_path)
    assert reread.read_part("word/header1.xml").decode() == "<header>from master</header>"
    assert reread.read_part("word/footer1.xml").decode() == "<footer>from master</footer>"


def test_sync_media_renames_master_images(tmp_path: Path) -> None:
    master_path = tmp_path / "master.docx"
    target_path = tmp_path / "target.docx"

    master_header_rels = (
        '<?xml version="1.0"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image4.emf"/>'
        "</Relationships>"
    )
    with zipfile.ZipFile(master_path, "w") as z:
        z.writestr("[Content_Types].xml", "<x/>")
        z.writestr("_rels/.rels", "<x/>")
        z.writestr("word/document.xml", "<x/>")
        z.writestr("word/header1.xml", "<h/>")
        z.writestr("word/_rels/header1.xml.rels", master_header_rels)
        z.writestr("word/media/image4.emf", b"MASTER-IMAGE-BYTES")

    with zipfile.ZipFile(target_path, "w") as z:
        z.writestr("[Content_Types].xml", "<x/>")
        z.writestr("_rels/.rels", "<x/>")
        z.writestr("word/document.xml", "<x/>")
        z.writestr("word/media/image4.emf", b"TARGET-OWN-IMAGE")

    from scripts.briefkopf_lib.sync import sync_header_footer, sync_media

    target = DocxBundle.read(target_path)
    master = DocxBundle.read(master_path)
    sync_header_footer(target, master)
    sync_media(target, master)
    target.save(target_path)

    reread = DocxBundle.read(target_path)
    assert reread.read_part("word/media/image4.emf") == b"TARGET-OWN-IMAGE"
    assert reread.read_part("word/media/briefkopf_image4.emf") == b"MASTER-IMAGE-BYTES"
    rels = reread.read_part("word/_rels/header1.xml.rels").decode()
    assert 'Target="media/briefkopf_image4.emf"' in rels
