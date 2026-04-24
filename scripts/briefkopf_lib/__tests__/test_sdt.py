"""Test SDT (Structured Document Tag) find/replace."""
from lxml import etree

from scripts.briefkopf_lib.sdt import find_sdts_by_tag, replace_sdt, NS_W


W = f"{{{NS_W}}}"


def _doc(*children_xml: str) -> etree._Element:
    xml = (
        f'<w:document xmlns:w="{NS_W}">'
        f"<w:body>{''.join(children_xml)}</w:body>"
        f"</w:document>"
    )
    return etree.fromstring(xml)


def _sdt(tag: str, inner: str) -> str:
    return (
        "<w:sdt>"
        "<w:sdtPr>"
        f'<w:tag w:val="{tag}"/>'
        "</w:sdtPr>"
        f"<w:sdtContent>{inner}</w:sdtContent>"
        "</w:sdt>"
    )


def test_find_sdts_by_tag_returns_matching_sdts():
    doc = _doc(
        _sdt("briefkopf-sidebar", "<w:p><w:r><w:t>old sidebar</w:t></w:r></w:p>"),
        "<w:p><w:r><w:t>body text</w:t></w:r></w:p>",
        _sdt("briefkopf-sachbearbeiter", "<w:p><w:r><w:t>old sb</w:t></w:r></w:p>"),
    )
    sidebars = find_sdts_by_tag(doc, "briefkopf-sidebar")
    assert len(sidebars) == 1
    assert "old sidebar" in etree.tostring(sidebars[0], encoding="unicode")

    sbs = find_sdts_by_tag(doc, "briefkopf-sachbearbeiter")
    assert len(sbs) == 1

    missing = find_sdts_by_tag(doc, "nope")
    assert missing == []


def test_replace_sdt_swaps_content_from_other_doc():
    target_doc = _doc(
        _sdt("briefkopf-sidebar", "<w:p><w:r><w:t>OLD</w:t></w:r></w:p>"),
        "<w:p><w:r><w:t>body outside sdt</w:t></w:r></w:p>",
    )
    master_doc = _doc(
        _sdt("briefkopf-sidebar", "<w:p><w:r><w:t>NEW master</w:t></w:r></w:p>"),
    )

    target_sdt = find_sdts_by_tag(target_doc, "briefkopf-sidebar")[0]
    master_sdt = find_sdts_by_tag(master_doc, "briefkopf-sidebar")[0]

    replace_sdt(target_sdt, master_sdt)

    out = etree.tostring(target_doc, encoding="unicode")
    assert "NEW master" in out
    assert "OLD" not in out
    assert "body outside sdt" in out  # body untouched
