"""Test the DocxBundle ZIP wrapper."""
from pathlib import Path
import zipfile

import pytest

from scripts.briefkopf_lib.docx_zip import DocxBundle


def _make_minimal_docx(path: Path) -> None:
    """Create the smallest valid DOCX file for testing."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
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
        z.writestr(
            "word/document.xml",
            '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body>"
            "</w:document>",
        )


def test_read_and_write_roundtrip(tmp_path: Path) -> None:
    src = tmp_path / "in.docx"
    _make_minimal_docx(src)

    bundle = DocxBundle.read(src)
    body = bundle.read_part("word/document.xml").decode("utf-8")
    assert "hello" in body

    bundle.write_part("word/document.xml", body.replace("hello", "world").encode("utf-8"))

    dst = tmp_path / "out.docx"
    bundle.save(dst)

    bundle2 = DocxBundle.read(dst)
    assert "world" in bundle2.read_part("word/document.xml").decode("utf-8")


def test_list_parts(tmp_path: Path) -> None:
    src = tmp_path / "in.docx"
    _make_minimal_docx(src)
    bundle = DocxBundle.read(src)
    parts = set(bundle.list_parts())
    assert "word/document.xml" in parts
    assert "[Content_Types].xml" in parts
