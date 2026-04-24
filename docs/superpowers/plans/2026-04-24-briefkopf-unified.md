# Unified Briefkopf Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propagiere einen einheitlichen TBS-Briefkopf (Logo, Partner-Sidebar, Siegel, Sachbearbeiter-Block, Footer) aus einem Master-DOCX in alle 13 Templates (3 Gutachten + 10 Anschreiben), mit `<w:sdt>` Content Controls als Sync-Grenze. Körper der Templates außerhalb der SDTs bleibt unberührt.

**Architecture:** Master-DOCX `briefkopf/briefkopf-master.docx` enthält 4 body-anchored SDT-Blöcke (sidebar, siegel-dekra, siegel-vid, sachbearbeiter) plus Header1/2 + Footer1/2 mit Logo/Dekobars/Partnerschaftsregister. Zwei Skripte: `scripts/create_briefkopf_master.py` (einmalige Master-Erzeugung aus bestehendem `Briefkopf_TBS.docx`) und eine erweiterte Version von `scripts/update-briefkopf.py`, die SDT-Inhalt + Header/Footer-Parts + Master-referenzierte Medien in die 13 Ziel-Templates propagiert.

**Tech Stack:** Python 3.11+, `python-docx`, `lxml`, `zipfile` (stdlib). Spec: `docs/superpowers/specs/2026-04-24-briefkopf-unified-design.md`.

**Milestones (testbar lokal):**
- **M1** (Task 1-4): Master erzeugen, in Word prüfen — 4 SDTs sichtbar
- **M2** (Task 5-7): Sync auf *einem* Anschreiben (Bankenanfrage) — in Word öffnen, Briefkopf sichtbar, Body unberührt
- **M3** (Task 8): Sync auf allen 10 Anschreiben
- **M4** (Task 9): Gutachten-Migration + Sync
- **M5** (Task 10): Partner-Sidebar-Rendering aus `kanzlei.json`
- **M6** (Task 11): 3-Viewer-Akzeptanztest (Word Desktop, Word Online, LibreOffice)

---

## Task 1: Projektskelett + DOCX-Helpers

**Files:**
- Create: `scripts/briefkopf_lib/__init__.py`
- Create: `scripts/briefkopf_lib/docx_zip.py`
- Create: `scripts/briefkopf_lib/__tests__/__init__.py`
- Create: `scripts/briefkopf_lib/__tests__/test_docx_zip.py`

**Context:** Alle Brief­kopf-Skripte brauchen dieselben DOCX-ZIP-Operationen (open, list-parts, read-part, write-part). Wir extrahieren sie in eine Library, damit die beiden Top-Level-Skripte (`create_briefkopf_master.py`, `update-briefkopf.py`) sich nicht wiederholen.

- [ ] **Step 1.1: Verzeichnisse anlegen**

```bash
mkdir -p scripts/briefkopf_lib/__tests__
touch scripts/briefkopf_lib/__init__.py
touch scripts/briefkopf_lib/__tests__/__init__.py
```

- [ ] **Step 1.2: Failing test für `DocxBundle.read_part` + `write_part`**

Erstelle `scripts/briefkopf_lib/__tests__/test_docx_zip.py`:

```python
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
```

- [ ] **Step 1.3: Run test — erwartet Fehler**

```bash
cd /Users/thorsten/KlareProzesse.de/TBS/insolvenz-extraktor
python -m pytest scripts/briefkopf_lib/__tests__/test_docx_zip.py -v
```

Expected: ImportError oder ModuleNotFoundError für `docx_zip`.

- [ ] **Step 1.4: Implementiere `docx_zip.py`**

```python
"""Simple in-memory DOCX bundle. Read once, mutate parts, save atomically."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import zipfile
from typing import Iterable


@dataclass
class DocxBundle:
    """Holds all parts of a DOCX in memory as raw bytes, preserving order."""
    _parts: dict[str, bytes] = field(default_factory=dict)
    _order: list[str] = field(default_factory=list)

    @classmethod
    def read(cls, path: Path) -> "DocxBundle":
        bundle = cls()
        with zipfile.ZipFile(path, "r") as z:
            for name in z.namelist():
                bundle._parts[name] = z.read(name)
                bundle._order.append(name)
        return bundle

    def list_parts(self) -> Iterable[str]:
        return list(self._order)

    def has_part(self, name: str) -> bool:
        return name in self._parts

    def read_part(self, name: str) -> bytes:
        if name not in self._parts:
            raise KeyError(f"DOCX part not found: {name}")
        return self._parts[name]

    def write_part(self, name: str, data: bytes) -> None:
        if name not in self._parts:
            self._order.append(name)
        self._parts[name] = data

    def delete_part(self, name: str) -> None:
        if name in self._parts:
            del self._parts[name]
            self._order.remove(name)

    def save(self, path: Path) -> None:
        tmp = path.with_suffix(path.suffix + ".tmp")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for name in self._order:
                z.writestr(name, self._parts[name])
        tmp.replace(path)
```

- [ ] **Step 1.5: Run test — erwartet PASS**

```bash
python -m pytest scripts/briefkopf_lib/__tests__/test_docx_zip.py -v
```

Expected: 2 passed.

- [ ] **Step 1.6: Commit**

```bash
git add scripts/briefkopf_lib/ docs/superpowers/plans/2026-04-24-briefkopf-unified.md
git commit -m "feat(briefkopf): DocxBundle library + roundtrip tests"
```

---

## Task 2: SDT find/replace Helper

**Files:**
- Create: `scripts/briefkopf_lib/sdt.py`
- Create: `scripts/briefkopf_lib/__tests__/test_sdt.py`

**Context:** Kern-Primitive: ein SDT mit bekanntem Tag im `word/document.xml` finden und dessen Inhalt durch einen Block aus dem Master ersetzen. SDT-Tag ist in `<w:sdtPr><w:tag w:val="briefkopf-sidebar"/></w:sdtPr>`.

- [ ] **Step 2.1: Failing tests schreiben**

Erstelle `scripts/briefkopf_lib/__tests__/test_sdt.py`:

```python
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
```

- [ ] **Step 2.2: Run — erwartet Fehler**

```bash
python -m pytest scripts/briefkopf_lib/__tests__/test_sdt.py -v
```

Expected: ImportError.

- [ ] **Step 2.3: `sdt.py` implementieren**

```python
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
```

- [ ] **Step 2.4: Run — erwartet PASS**

```bash
python -m pytest scripts/briefkopf_lib/__tests__/test_sdt.py -v
```

Expected: 2 passed.

- [ ] **Step 2.5: Commit**

```bash
git add scripts/briefkopf_lib/sdt.py scripts/briefkopf_lib/__tests__/test_sdt.py
git commit -m "feat(briefkopf): SDT find/replace helpers + tests"
```

---

## Task 3: Master-Erzeugungsskript (einmalig, programmatisch)

**Files:**
- Create: `scripts/create_briefkopf_master.py`
- Create: `briefkopf/` (Verzeichnis, kein tracked content bis Skript läuft)

**Context:** Der existierende `/Users/thorsten/Downloads/Briefkopf_TBS.docx` hat den Briefkopf im Body als 3 floating anchors (Sidebar, DEKRA-Siegel, VID-Siegel) plus einen inline Sachbearbeiter-Paragraph-Block. Wir erzeugen daraus `briefkopf/briefkopf-master.docx` durch: (1) Empfänger-Paragraphen löschen, (2) die 4 Briefkopf-Elemente in SDTs wrappen, (3) `{{PARTNER_SIDEBAR}}` Marker in der Sidebar-Textbox ersetzen.

Identifizierung (aus der Inspection im Spec-Prozess bestätigt):
- Sidebar: `<w:drawing>` mit `<wp:anchor>` mit extent cx=5.5cm (ca. 1980000 EMU) — eindeutig größter Anchor
- Siegel DEKRA: anchor mit extent cx=1.2cm (432000 EMU), blip zeigt auf image1.png
- Siegel VID: anchor cx=1.6cm (576000 EMU), blip zeigt auf image2.jpeg
- Sachbearbeiter-Block: Paragraphen ab dem mit Text "Sachbearbeiter/in" bis vor dem ersten leeren Trennparagraph danach

- [ ] **Step 3.1: Skript anlegen mit CLI-Gerüst**

```python
#!/usr/bin/env python3
"""
One-shot: erzeuge `briefkopf/briefkopf-master.docx` aus `/Users/thorsten/Downloads/Briefkopf_TBS.docx`.

Wrapt die 4 Body-Briefkopf-Elemente in <w:sdt> Content Controls mit stabilen Tags,
entfernt Empfänger-Paragraphen. Header/Footer/Media bleiben unverändert.

Usage:
    python scripts/create_briefkopf_master.py \\
        --source ~/Downloads/Briefkopf_TBS.docx \\
        --output briefkopf/briefkopf-master.docx
"""
from __future__ import annotations

import argparse
from pathlib import Path
from copy import deepcopy

from lxml import etree

# Make `scripts.briefkopf_lib.*` importable when running this script directly.
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.briefkopf_lib.docx_zip import DocxBundle
from scripts.briefkopf_lib.sdt import NS_W

_W = f"{{{NS_W}}}"
NS_WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
_WP = f"{{{NS_WP}}}"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    bundle = DocxBundle.read(args.source)
    doc_xml = bundle.read_part("word/document.xml")
    doc = etree.fromstring(doc_xml)

    body = doc.find(f"./{_W}body")
    assert body is not None, "document.xml has no body"

    wrap_briefkopf_elements(body)
    strip_sample_empfaenger_paragraphs(body)

    new_xml = etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True)
    bundle.write_part("word/document.xml", new_xml)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    bundle.save(args.output)
    print(f"Wrote {args.output}")


def wrap_briefkopf_elements(body: etree._Element) -> None:
    """Wrap each of the 4 briefkopf elements in a <w:sdt> with a stable tag."""
    raise NotImplementedError  # Step 3.3


def strip_sample_empfaenger_paragraphs(body: etree._Element) -> None:
    """Remove the 'Amtsgericht Trier / Justizstraße 2-6 / 54290 Trier' block."""
    raise NotImplementedError  # Step 3.5


if __name__ == "__main__":
    main()
```

- [ ] **Step 3.2: Kleine Smoke-Check-Runs (CLI funktioniert, stoppt bei NotImplementedError)**

```bash
python scripts/create_briefkopf_master.py --source ~/Downloads/Briefkopf_TBS.docx --output /tmp/out.docx
```

Expected: `NotImplementedError` in `wrap_briefkopf_elements`.

- [ ] **Step 3.3: Implementiere `wrap_briefkopf_elements` — Sidebar + Siegel**

Ersetze `raise NotImplementedError` in `wrap_briefkopf_elements`:

```python
def wrap_briefkopf_elements(body: etree._Element) -> None:
    """Wrap each of the 4 briefkopf elements in a <w:sdt> with a stable tag."""
    # 1. Sidebar: find the largest wp:anchor (cx > 5000000 EMU → 5.5cm wide textbox)
    # 2. Siegel DEKRA: anchor with blip embed pointing to image1.png
    # 3. Siegel VID:   anchor with blip embed pointing to image2.jpeg
    # 4. Sachbearbeiter-Block: paragraph range from "Sachbearbeiter/in" onward

    anchors = list(body.iter(f"{_WP}anchor"))

    # Classify anchors by size + media target
    sidebar_anchor = None
    siegel_dekra = None
    siegel_vid = None
    for a in anchors:
        extent = a.find(f"{_WP}extent")
        if extent is None:
            continue
        cx = int(extent.get("cx", "0"))
        # extract blip rId
        blip = a.find(".//{http://schemas.openxmlformats.org/drawingml/2006/main}blip")
        embed = blip.get(f"{{http://schemas.openxmlformats.org/officeDocument/2006/relationships}}embed") if blip is not None else None

        if cx > 1500000:  # ~4cm+ → sidebar textbox
            sidebar_anchor = a
        elif embed == "rId8":
            siegel_dekra = a
        elif embed == "rId9":
            siegel_vid = a

    for anchor, tag in [
        (sidebar_anchor, "briefkopf-sidebar"),
        (siegel_dekra, "briefkopf-siegel-dekra"),
        (siegel_vid, "briefkopf-siegel-vid"),
    ]:
        if anchor is None:
            raise RuntimeError(f"anchor for {tag} not found in master body")
        _wrap_in_sdt(anchor, tag)


def _wrap_in_sdt(element: etree._Element, tag: str) -> None:
    """Enclose `element` (and its containing <w:p>/<w:r>) in a new <w:sdt>.

    wp:anchor lives inside <w:drawing> inside <w:r> inside <w:p>. We wrap the
    entire <w:p> so the SDT-Block stands alone in the body.
    """
    run = element.getparent().getparent() if element.getparent().tag == f"{_W}drawing" else element.getparent()
    paragraph = run.getparent()  # w:p
    parent = paragraph.getparent()  # w:body
    idx = list(parent).index(paragraph)

    sdt = etree.SubElement(parent, f"{_W}sdt")
    sdt_pr = etree.SubElement(sdt, f"{_W}sdtPr")
    tag_el = etree.SubElement(sdt_pr, f"{_W}tag")
    tag_el.set(f"{_W}val", tag)
    sdt_content = etree.SubElement(sdt, f"{_W}sdtContent")

    parent.remove(paragraph)
    sdt_content.append(paragraph)

    # Now move sdt to the right place (it got appended at end; move to original idx)
    parent.remove(sdt)
    parent.insert(idx, sdt)
```

- [ ] **Step 3.4: Run — erwartet NotImplementedError in `strip_sample_empfaenger_paragraphs`**

```bash
python scripts/create_briefkopf_master.py --source ~/Downloads/Briefkopf_TBS.docx --output /tmp/out.docx
```

Expected: skript läuft weiter, erreicht `strip_sample_empfaenger_paragraphs`, NotImplementedError.

- [ ] **Step 3.5: Implementiere `strip_sample_empfaenger_paragraphs` + Sachbearbeiter-Wrap**

```python
def strip_sample_empfaenger_paragraphs(body: etree._Element) -> None:
    """Remove the 'Amtsgericht Trier / Justizstraße 2-6 / 54290 Trier' block.

    These are sample recipient lines — belong in each target template's body,
    not in the master. We identify them as the first 4 paragraphs of the body
    that precede the Absenderzeile ("Prof. Dr. Dr. Thomas B. Schmidt ...").
    """
    # Find the Absenderzeile paragraph (marks end of empfänger block)
    paragraphs = list(body.findall(f"./{_W}p"))
    absender_idx = None
    for i, p in enumerate(paragraphs):
        text = "".join(t.text or "" for t in p.iter(f"{_W}t"))
        if "Prof. Dr. Dr. Thomas B. Schmidt" in text:
            absender_idx = i
            break
    if absender_idx is None:
        return  # no empfänger block found
    for p in paragraphs[:absender_idx]:
        body.remove(p)


def wrap_sachbearbeiter_block(body: etree._Element) -> None:
    """Wrap the Sachbearbeiter-block paragraphs (Absenderzeile through 'Ihr Zeichen')
    in a briefkopf-sachbearbeiter SDT."""
    paragraphs = list(body.findall(f"./{_W}p"))
    start_idx = end_idx = None
    for i, p in enumerate(paragraphs):
        text = "".join(t.text or "" for t in p.iter(f"{_W}t"))
        if start_idx is None and "Prof. Dr. Dr. Thomas B. Schmidt" in text:
            start_idx = i
        if start_idx is not None and "Ihr Zeichen" in text:
            end_idx = i
            break
    if start_idx is None or end_idx is None:
        raise RuntimeError("Sachbearbeiter paragraph range not found")

    target_range = paragraphs[start_idx : end_idx + 1]
    sdt = etree.Element(f"{_W}sdt")
    sdt_pr = etree.SubElement(sdt, f"{_W}sdtPr")
    tag_el = etree.SubElement(sdt_pr, f"{_W}tag")
    tag_el.set(f"{_W}val", "briefkopf-sachbearbeiter")
    sdt_content = etree.SubElement(sdt, f"{_W}sdtContent")

    insert_idx = list(body).index(target_range[0])
    for p in target_range:
        body.remove(p)
        sdt_content.append(p)
    body.insert(insert_idx, sdt)
```

Dann in `main()` nach `wrap_briefkopf_elements(body)` hinzufügen:

```python
    wrap_sachbearbeiter_block(body)
```

- [ ] **Step 3.6: Run — Master-DOCX wird erzeugt**

```bash
python scripts/create_briefkopf_master.py \
    --source ~/Downloads/Briefkopf_TBS.docx \
    --output briefkopf/briefkopf-master.docx
```

Expected: `Wrote briefkopf/briefkopf-master.docx`.

- [ ] **Step 3.7: Visueller Test in Word — MILESTONE 1**

```bash
open briefkopf/briefkopf-master.docx
```

Erwartung (vom Benutzer zu bestätigen):
- Sidebar rechts mit Partner-Liste sichtbar
- DEKRA-Siegel + VID-Siegel sichtbar
- Sachbearbeiter-Block im oberen rechten Bereich
- Alle 4 Blöcke als **Inhaltssteuerelemente** markiert (wenn Entwicklertab aktiv ist, sieht man den Rahmen)
- Empfängerblock "Amtsgericht Trier" ist weg
- Logo-Dekobar oben + Footer bleiben

Wenn visuell OK: weiter. Wenn nicht: zurück zu Step 3.3/3.5 und Anchor-Identifikation anpassen.

- [ ] **Step 3.8: Commit**

```bash
mkdir -p briefkopf
git add scripts/create_briefkopf_master.py briefkopf/briefkopf-master.docx
git commit -m "feat(briefkopf): one-shot master creation from Briefkopf_TBS.docx"
```

---

## Task 4: Sync-Skript-Gerüst (Single-Template-Modus)

**Files:**
- Create: `scripts/briefkopf_lib/sync.py`
- Create: `scripts/briefkopf_lib/__tests__/test_sync.py`
- Modify: rename old `scripts/update-briefkopf.py` → `scripts/update-briefkopf.legacy.py` (Rollback-Anker)

**Context:** Der MVP-Sync läuft auf ein Template, ersetzt die 4 SDT-Inhalte aus dem Master, tauscht Header/Footer-Parts, importiert Media kollisionssicher. Noch kein Partner-Rendering, noch kein sectPr-Update (Templates haben noch keine Header/Footer-Refs).

- [ ] **Step 4.1: Alten Skript umbenennen**

```bash
git mv scripts/update-briefkopf.py scripts/update-briefkopf.legacy.py
```

- [ ] **Step 4.2: Failing test — SDT content replacement im Template**

Erstelle `scripts/briefkopf_lib/__tests__/test_sync.py`:

```python
"""Integration test: replace SDTs in a target DOCX from a master."""
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
```

- [ ] **Step 4.3: Run — ImportError**

```bash
python -m pytest scripts/briefkopf_lib/__tests__/test_sync.py -v
```

- [ ] **Step 4.4: `sync.py` implementieren**

```python
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
```

- [ ] **Step 4.5: Run — PASS**

```bash
python -m pytest scripts/briefkopf_lib/__tests__/test_sync.py -v
```

- [ ] **Step 4.6: Commit**

```bash
git add scripts/briefkopf_lib/sync.py scripts/briefkopf_lib/__tests__/test_sync.py scripts/update-briefkopf.legacy.py
git commit -m "feat(briefkopf): sync_sdts — SDT-scoped body replacement"
```

---

## Task 5: Header/Footer-Parts + Media-Import

**Files:**
- Modify: `scripts/briefkopf_lib/sync.py` (add `sync_header_footer`, `sync_media`)
- Modify: `scripts/briefkopf_lib/__tests__/test_sync.py`

**Context:** Nach SDT-Replace müssen die 4 Header/Footer-XMLs und die vom Master referenzierten Media ins Ziel kopiert werden. Media-Kollision: bestehende `word/media/image1.png` im Ziel darf nicht überschrieben werden, wenn sie anders ist als Masters `image1.png`. Strategie: Master-Media immer unter eindeutigem Namen `briefkopf_<orig>.png` importieren; Rels in den kopierten Header/Footer-Parts und SDT-rels entsprechend umbiegen.

- [ ] **Step 5.1: Failing test — header/footer + media copy**

Ergänze `scripts/briefkopf_lib/__tests__/test_sync.py`:

```python
def test_sync_header_footer_copies_parts_from_master(tmp_path: Path) -> None:
    master_path = tmp_path / "master.docx"
    target_path = tmp_path / "target.docx"

    # Master has header1 + footer1
    with zipfile.ZipFile(master_path, "w") as z:
        z.writestr("[Content_Types].xml", "<x/>")
        z.writestr("_rels/.rels", "<x/>")
        z.writestr("word/document.xml", "<x/>")
        z.writestr("word/header1.xml", "<header>from master</header>")
        z.writestr("word/_rels/header1.xml.rels", "<x/>")
        z.writestr("word/footer1.xml", "<footer>from master</footer>")
        z.writestr("word/_rels/footer1.xml.rels", "<x/>")

    # Target has empty body, no headers
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

    # Master has an image referenced by master's header via rId5
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

    # Target already has its own image4.emf (different content)
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
    # target's original image must survive under its original name
    assert reread.read_part("word/media/image4.emf") == b"TARGET-OWN-IMAGE"
    # master's image must be imported under briefkopf_-prefixed name
    assert reread.read_part("word/media/briefkopf_image4.emf") == b"MASTER-IMAGE-BYTES"
    # the imported header rels must reference the new name
    rels = reread.read_part("word/_rels/header1.xml.rels").decode()
    assert 'Target="media/briefkopf_image4.emf"' in rels
```

- [ ] **Step 5.2: Run — Fehler**

- [ ] **Step 5.3: Implementiere `sync_header_footer` + `sync_media`**

Am Ende von `scripts/briefkopf_lib/sync.py`:

```python
HEADER_FOOTER_PARTS = ["header1.xml", "header2.xml", "footer1.xml", "footer2.xml"]


def sync_header_footer(target: DocxBundle, master: DocxBundle) -> None:
    """Copy header1/2 + footer1/2 XMLs and their rels from master."""
    for base in HEADER_FOOTER_PARTS:
        part = f"word/{base}"
        rels = f"word/_rels/{base}.rels"
        # Delete target's old copy (if any), then import from master (if master has it)
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
    name_map: dict[str, str] = {}  # old name → new name, for rels patching

    for old in master_media_names:
        basename = old.split("/")[-1]
        new_name = f"word/media/briefkopf_{basename}"
        name_map[f"media/{basename}"] = f"media/briefkopf_{basename}"
        target.write_part(new_name, master.read_part(old))

    # Patch every header/footer rels we just imported
    for base in HEADER_FOOTER_PARTS:
        rels_part = f"word/_rels/{base}.rels"
        if not target.has_part(rels_part):
            continue
        rels_xml = target.read_part(rels_part).decode("utf-8")
        for old, new in name_map.items():
            rels_xml = rels_xml.replace(f'Target="{old}"', f'Target="{new}"')
        target.write_part(rels_part, rels_xml.encode("utf-8"))
```

- [ ] **Step 5.4: Run — PASS**

```bash
python -m pytest scripts/briefkopf_lib/__tests__/test_sync.py -v
```

- [ ] **Step 5.5: Commit**

```bash
git add scripts/briefkopf_lib/sync.py scripts/briefkopf_lib/__tests__/test_sync.py
git commit -m "feat(briefkopf): sync_header_footer + sync_media with collision-safe rename"
```

---

## Task 6: sectPr-Setup + Content-Types + document.xml.rels-Patch

**Files:**
- Modify: `scripts/briefkopf_lib/sync.py` (add `ensure_section_properties`, `patch_content_types`, `patch_document_rels`)
- Modify: `scripts/briefkopf_lib/__tests__/test_sync.py`

**Context:** Ein Ziel-Template, das vorher keine Header/Footer hatte, muss in seiner `<w:sectPr>` jetzt Referenzen auf header1/2 + footer1/2 bekommen, mit `<w:titlePg/>`. Außerdem müssen `[Content_Types].xml` neue Header/Footer-Overrides haben und `word/_rels/document.xml.rels` die rIds + Targets.

- [ ] **Step 6.1: Failing test**

In `test_sync.py`:

```python
def test_ensure_section_properties_adds_titlePg_and_refs(tmp_path: Path) -> None:
    from scripts.briefkopf_lib.sync import ensure_section_properties

    doc_xml = (
        '<?xml version="1.0"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>"
        "<w:p/>"
        "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/></w:sectPr>"
        "</w:body>"
        "</w:document>"
    )
    doc = etree.fromstring(doc_xml)
    ensure_section_properties(doc, {
        "first-header": "rId100",
        "first-footer": "rId101",
        "default-header": "rId102",
        "default-footer": "rId103",
    })
    out = etree.tostring(doc, encoding="unicode")
    assert "<w:titlePg" in out
    # all 4 refs present
    assert 'w:type="first"' in out
    assert 'w:type="default"' in out
```

- [ ] **Step 6.2: Implementieren**

```python
def ensure_section_properties(doc: etree._Element, rids: dict[str, str]) -> None:
    """Set titlePg + header/footer refs on the body's final <w:sectPr>.

    Keys: first-header, first-footer, default-header, default-footer.
    """
    body = doc.find(f"./{_W}body")
    assert body is not None
    sect_pr = body.find(f"./{_W}sectPr")
    if sect_pr is None:
        sect_pr = etree.SubElement(body, f"{_W}sectPr")

    # Remove any existing header/footer refs and titlePg (we're re-adding them)
    for el in list(sect_pr):
        if el.tag in (f"{_W}headerReference", f"{_W}footerReference", f"{_W}titlePg"):
            sect_pr.remove(el)

    # Refs must come BEFORE pgSz/pgMar/etc — w:sectPr schema requires specific order.
    # Easiest: build a list of (new) elements, clear sect_pr, then reinsert
    #   [headerRef*, footerRef*, existing rest, titlePg]
    existing = list(sect_pr)
    for el in existing:
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

    for el in existing:
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
    rels_path = "word/_rels/document.xml.rels"
    rels_xml = target.read_part(rels_path).decode("utf-8") if target.has_part(rels_path) else (
        '<?xml version="1.0"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        "</Relationships>"
    )

    existing_ids = set()
    import re
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
    for key, target_path, rel_type in wanted:
        if f'Target="{target_path}"' in rels_xml:
            m = re.search(rf'Id="([^"]+)"[^/]*Target="{target_path}"', rels_xml)
            if m:
                rid_map[key] = m.group(1)
                continue
        new_id = _next_id()
        rel_entry = f'<Relationship Id="{new_id}" Type="{rel_type}" Target="{target_path}"/>'
        rels_xml = rels_xml.replace("</Relationships>", rel_entry + "</Relationships>")
        rid_map[key] = new_id

    target.write_part(rels_path, rels_xml.encode("utf-8"))
    return rid_map
```

- [ ] **Step 6.3: Run tests — PASS**

```bash
python -m pytest scripts/briefkopf_lib/__tests__/test_sync.py -v
```

- [ ] **Step 6.4: Commit**

```bash
git commit -am "feat(briefkopf): sectPr + content-types + document rels patching"
```

---

## Task 7: Top-Level-Skript `update-briefkopf.py` (Single-Template-Mode)

**Files:**
- Create: `scripts/update-briefkopf.py` (der neue, SDT-basierte Ersatz für `update-briefkopf.legacy.py`)

**Context:** Das Top-Level-Skript orchestriert alle sync-Funktionen für ein einzelnes Template. CLI: `--template <name>` erst; `--all` folgt in Task 8.

- [ ] **Step 7.1: Skript schreiben**

```python
#!/usr/bin/env python3
"""
Propagate the master briefkopf (header, footer, partner sidebar, sachbearbeiter)
into target templates via SDT-scoped body replacement + full header/footer swap.

Spec: docs/superpowers/specs/2026-04-24-briefkopf-unified-design.md
Plan: docs/superpowers/plans/2026-04-24-briefkopf-unified.md

Usage:
    python scripts/update-briefkopf.py --template Bankenanfrage
    python scripts/update-briefkopf.py --all
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from lxml import etree

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from scripts.briefkopf_lib.docx_zip import DocxBundle
from scripts.briefkopf_lib.sync import (
    BRIEFKOPF_SDT_TAGS,
    ensure_section_properties,
    patch_content_types,
    patch_document_rels,
    sync_header_footer,
    sync_media,
    sync_sdts,
)

MASTER_PATH = REPO / "briefkopf" / "briefkopf-master.docx"

GUTACHTEN_DIR = REPO / "gutachtenvorlagen"
ANSCHREIBEN_DIR = REPO / "standardschreiben" / "templates"

GUTACHTEN_TEMPLATES = [
    "Gutachten Muster natürliche Person.docx",
    "Gutachten Muster juristische Person.docx",
    "Gutachten Muster Personengesellschaft.docx",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true")
    g.add_argument("--only", choices=["gutachten", "anschreiben"])
    g.add_argument("--template", type=str, help="basename without .docx")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def resolve_targets(args: argparse.Namespace) -> list[Path]:
    gutachten = [GUTACHTEN_DIR / n for n in GUTACHTEN_TEMPLATES]
    anschreiben = sorted(ANSCHREIBEN_DIR.glob("*.docx"))
    if args.all:
        return gutachten + anschreiben
    if args.only == "gutachten":
        return gutachten
    if args.only == "anschreiben":
        return anschreiben
    if args.template:
        for p in gutachten + anschreiben:
            if p.stem == args.template:
                return [p]
        raise SystemExit(f"template not found: {args.template}")
    raise SystemExit("must pass --all or --only or --template")


def sync_template(target_path: Path, master: DocxBundle, dry_run: bool) -> None:
    print(f"\n→ {target_path.relative_to(REPO)}")
    if not target_path.exists():
        print("  SKIP: file missing")
        return
    target = DocxBundle.read(target_path)

    sync_sdts(target, master, BRIEFKOPF_SDT_TAGS)
    sync_header_footer(target, master)
    sync_media(target, master)
    patch_content_types(target)
    rid_map = patch_document_rels(target)

    doc = etree.fromstring(target.read_part("word/document.xml"))
    ensure_section_properties(doc, rid_map)
    target.write_part(
        "word/document.xml",
        etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True),
    )

    if dry_run:
        print("  [dry-run] would write")
        return

    backup = target_path.with_suffix(".backup.docx")
    if not backup.exists():
        backup.write_bytes(target_path.read_bytes())
        print(f"  backup → {backup.name}")

    target.save(target_path)
    print("  ✓ synced")


def main() -> None:
    args = parse_args()
    if not MASTER_PATH.exists():
        raise SystemExit(f"master not found: {MASTER_PATH} — run create_briefkopf_master.py first")
    master = DocxBundle.read(MASTER_PATH)

    for t in resolve_targets(args):
        sync_template(t, master, args.dry_run)


if __name__ == "__main__":
    main()
```

- [ ] **Step 7.2: Smoke-Run auf einem Anschreiben (dry-run)**

```bash
python scripts/update-briefkopf.py --template Bankenanfrage --dry-run
```

Expected: "would write" — keine Fehler.

- [ ] **Step 7.3: Echter Run auf Bankenanfrage**

```bash
python scripts/update-briefkopf.py --template Bankenanfrage
```

Expected: `backup → Bankenanfrage.backup.docx` + `✓ synced`.

- [ ] **Step 7.4: MILESTONE 2 — visueller Test**

```bash
open standardschreiben/templates/Bankenanfrage.docx
```

Erwartung (vom Benutzer zu bestätigen):
- Briefkopf sichtbar (Logo oben, Sidebar, Siegel, Sachbearbeiter-Block)
- Original-Body der Bankenanfrage (Empfängerfeld, Betreff, Fließtext mit `FELD_*`) unverändert sichtbar
- Alle 4 SDTs als Content Controls erkennbar (Entwickler-Tab)
- Seite 2+ zeigt nur Footer

Wenn Überlappung Body ↔ Sidebar: → `pgMar w:right` im Body anpassen (späterer Feinschliff).

- [ ] **Step 7.5: Rollback-Test**

```bash
cp standardschreiben/templates/Bankenanfrage.backup.docx standardschreiben/templates/Bankenanfrage.docx
open standardschreiben/templates/Bankenanfrage.docx
```

Expected: Original wieder da.

Dann Sync nochmal laufen lassen:

```bash
python scripts/update-briefkopf.py --template Bankenanfrage
```

- [ ] **Step 7.6: Commit**

```bash
git add scripts/update-briefkopf.py standardschreiben/templates/Bankenanfrage.docx standardschreiben/templates/Bankenanfrage.backup.docx
git commit -m "feat(briefkopf): top-level sync CLI — MVP on Bankenanfrage"
```

---

## Task 8: Alle 10 Anschreiben

**Files:**
- Modify: Läuft über alle Anschreiben. Keine Code-Änderung, nur Execution.

- [ ] **Step 8.1: Dry-run über alle Anschreiben**

```bash
python scripts/update-briefkopf.py --only anschreiben --dry-run
```

Expected: 10 Zeilen `would write`, keine Fehler.

- [ ] **Step 8.2: Echter Run**

```bash
python scripts/update-briefkopf.py --only anschreiben
```

- [ ] **Step 8.3: MILESTONE 3 — stichprobenweise Sichtprüfung**

```bash
open standardschreiben/templates/Anfrage_ans_Finanzamt.docx
open standardschreiben/templates/Gewerbeanfrage.docx
open standardschreiben/templates/Einsichtnahmegesuch_Strafakte_Anfrage_zur_Akteneinsicht_.docx
```

Prüfe wie in Task 7.4.

Wenn alle OK:

- [ ] **Step 8.4: Commit alle Anschreiben**

```bash
git add standardschreiben/templates/*.docx standardschreiben/templates/*.backup.docx
git commit -m "chore(briefkopf): apply briefkopf master to all 10 Anschreiben"
```

---

## Task 9: Gutachten-Migration + Sync

**Files:**
- Create: `scripts/prepare_gutachten_for_briefkopf.py` — einmalige Body-Cleanup, fügt SDT-Stubs ein

**Context:** Die 3 Gutachten haben noch den alten Body-Briefkopf inline (Absenderzeile + Sachbearbeiter im Body, kein SDT-Wrapper). Dieser muss einmalig raus, dann SDT-Stubs am Body-Anfang eingefügt, damit `update-briefkopf.py` greifen kann.

- [ ] **Step 9.1: Prepare-Skript schreiben**

```python
#!/usr/bin/env python3
"""
One-shot: prepare the 3 Gutachten templates for the SDT-based briefkopf sync.

Removes the inline briefkopf paragraphs from body (Absenderzeile + Sachbearbeiter)
and inserts empty SDT stubs with the 4 briefkopf tags.

After this, running `update-briefkopf.py --only gutachten` will fill them.

Usage:
    python scripts/prepare_gutachten_for_briefkopf.py
"""
from __future__ import annotations

from pathlib import Path
import sys

from lxml import etree

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from scripts.briefkopf_lib.docx_zip import DocxBundle
from scripts.briefkopf_lib.sdt import NS_W

_W = f"{{{NS_W}}}"

GUTACHTEN_DIR = REPO / "gutachtenvorlagen"
TEMPLATES = [
    "Gutachten Muster natürliche Person.docx",
    "Gutachten Muster juristische Person.docx",
    "Gutachten Muster Personengesellschaft.docx",
]

MARKERS_START = ["Kornmarkt", "Prof. Dr. Dr. Thomas B. Schmidt Insolvenzverwalter"]
MARKER_END = "Ihr Zeichen"


def strip_inline_briefkopf(body: etree._Element) -> None:
    paragraphs = list(body.findall(f"./{_W}p"))
    start_idx = end_idx = None
    for i, p in enumerate(paragraphs):
        text = "".join(t.text or "" for t in p.iter(f"{_W}t"))
        if start_idx is None and any(m in text for m in MARKERS_START):
            start_idx = i
        if start_idx is not None and MARKER_END in text:
            end_idx = i
            break
    if start_idx is None or end_idx is None:
        print("  no inline briefkopf detected — skipping")
        return
    for p in paragraphs[start_idx : end_idx + 1]:
        body.remove(p)
    print(f"  removed {end_idx - start_idx + 1} inline briefkopf paragraphs")


def insert_sdt_stubs(body: etree._Element) -> None:
    """Insert 4 empty SDT stubs at the top of the body."""
    tags = [
        "briefkopf-sidebar",
        "briefkopf-siegel-dekra",
        "briefkopf-siegel-vid",
        "briefkopf-sachbearbeiter",
    ]
    for i, tag in enumerate(tags):
        sdt = etree.Element(f"{_W}sdt")
        sdt_pr = etree.SubElement(sdt, f"{_W}sdtPr")
        tag_el = etree.SubElement(sdt_pr, f"{_W}tag")
        tag_el.set(f"{_W}val", tag)
        sdt_content = etree.SubElement(sdt, f"{_W}sdtContent")
        etree.SubElement(sdt_content, f"{_W}p")  # empty paragraph placeholder
        body.insert(i, sdt)


def main() -> None:
    for name in TEMPLATES:
        path = GUTACHTEN_DIR / name
        print(f"\n→ {name}")
        bundle = DocxBundle.read(path)
        doc_xml = bundle.read_part("word/document.xml")
        doc = etree.fromstring(doc_xml)
        body = doc.find(f"./{_W}body")
        assert body is not None

        strip_inline_briefkopf(body)
        insert_sdt_stubs(body)

        new_xml = etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True)
        bundle.write_part("word/document.xml", new_xml)

        backup = path.with_suffix(".prepare-backup.docx")
        if not backup.exists():
            backup.write_bytes(path.read_bytes())
        bundle.save(path)
        print("  ✓ prepared")


if __name__ == "__main__":
    main()
```

- [ ] **Step 9.2: Prepare-Skript laufen lassen**

```bash
python scripts/prepare_gutachten_for_briefkopf.py
```

- [ ] **Step 9.3: Sync auf die 3 Gutachten**

```bash
python scripts/update-briefkopf.py --only gutachten
```

- [ ] **Step 9.4: MILESTONE 4 — visuell prüfen**

```bash
open "gutachtenvorlagen/Gutachten Muster natürliche Person.docx"
```

Erwartung:
- Kein alter Doppel-Briefkopf im Body
- Neuer einheitlicher Briefkopf auf Seite 1
- Gutachten-Inhaltsverzeichnis + Kapitelstruktur sichtbar wie vorher
- Alle `KI_*` und `[[SLOT_NNN]]` Platzhalter intakt

Bei Problem mit dem Cleanup: manuelle Korrektur in Word nötig (Gutachten-Migration ist heuristik-basiert und fragil).

- [ ] **Step 9.5: Commit**

```bash
git add scripts/prepare_gutachten_for_briefkopf.py gutachtenvorlagen/*.docx
git commit -m "chore(briefkopf): migrate 3 Gutachten templates to SDT-scoped briefkopf"
```

---

## Task 10: Partner-Sidebar-Rendering aus `kanzlei.json`

**Files:**
- Create: `scripts/briefkopf_lib/sidebar_render.py`
- Modify: `scripts/briefkopf_lib/sync.py` (call render after SDT-replace)
- Port: Logik aus `scripts/update-briefkopf.legacy.py:build_sidebar_lines()`

**Context:** Bisher wird die Partner-Sidebar 1:1 aus dem Master übernommen — enthält aber dort evtl. veraltete/test-Partner. Echte Daten kommen aus `gutachtenvorlagen/kanzlei.json`.

- [ ] **Step 10.1: Test schreiben**

Erstelle `scripts/briefkopf_lib/__tests__/test_sidebar_render.py`:

```python
"""Test partner sidebar rendering from kanzlei.json."""
from scripts.briefkopf_lib.sidebar_render import render_sidebar_lines


def test_renders_header_block():
    data = {
        "kanzlei": {
            "website": "www.example.de",
            "partnerschaftsregister": "AG X – PR 1",
        },
        "partner": [
            {"kategorie": "PARTNER", "name": "Ingo Grünewald", "titel": ["Fachanwalt"]},
        ],
        "standorte": {"Trier": {"adresse": "Kornmarkt 4, 54290 Trier", "telefon": ""}},
    }
    lines = render_sidebar_lines(data)
    texts = [l[1] for l in lines]
    assert "www.example.de" in texts
    assert "AG X – PR 1" in texts
    assert "Ingo Grünewald" in texts
    assert any("Kornmarkt" in t for t in texts)
```

- [ ] **Step 10.2: `sidebar_render.py` schreiben**

Portiere `build_sidebar_lines` aus `scripts/update-briefkopf.legacy.py`. Gibt eine Liste von `(role, text)` Tupeln zurück.

```python
"""Render partner sidebar lines from kanzlei.json data."""
from __future__ import annotations

from typing import Literal, Any

Role = Literal["name", "title", "header", "empty"]


def render_sidebar_lines(data: dict[str, Any]) -> list[tuple[Role, str]]:
    lines: list[tuple[Role, str]] = []
    lines.append(("name", data["kanzlei"]["website"]))
    lines.append(("title", "Partnerschaftsregister des"))
    lines.append(("title", data["kanzlei"]["partnerschaftsregister"]))
    lines.append(("empty", ""))
    lines.append(("empty", ""))

    by_category: dict[str, list[dict]] = {}
    for p in data.get("partner", []):
        by_category.setdefault(p["kategorie"], []).append(p)
    for cat in ["PARTNER", "ANGESTELLTE", "OF COUNSEL"]:
        members = by_category.get(cat, [])
        if not members:
            continue
        lines.append(("header", cat))
        for p in members:
            lines.append(("name", p["name"]))
            for t in p.get("titel", []):
                lines.append(("title", t))
            lines.append(("empty", ""))

    lines.append(("header", "STANDORTE"))
    for name, standort in data.get("standorte", {}).items():
        if not standort.get("adresse"):
            continue
        lines.append(("name", name))
        lines.append(("title", standort["adresse"]))
        if standort.get("telefon"):
            lines.append(("title", standort["telefon"]))
        lines.append(("empty", ""))
    return lines
```

- [ ] **Step 10.3: In `sync.py` Partner-Sidebar-Rendering nach SDT-Replace aufrufen**

In `sync.py`:

```python
def sync_sdts_with_sidebar_rendering(target: DocxBundle, master: DocxBundle, kanzlei: dict) -> None:
    """Replace all 4 briefkopf SDTs and render the sidebar from kanzlei data."""
    sync_sdts(target, master, BRIEFKOPF_SDT_TAGS)

    # Now re-render the sidebar SDT content from kanzlei.json
    from .sidebar_render import render_sidebar_lines
    doc = etree.fromstring(target.read_part("word/document.xml"))
    sidebars = find_sdts_by_tag(doc, "briefkopf-sidebar")
    if not sidebars:
        return
    sidebar_sdt = sidebars[0]
    _render_lines_into_sdt(sidebar_sdt, render_sidebar_lines(kanzlei))
    target.write_part(
        "word/document.xml",
        etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True),
    )


def _render_lines_into_sdt(sdt: etree._Element, lines: list[tuple[str, str]]) -> None:
    """Replace all <w:p> inside the sidebar's textbox with paragraphs built from `lines`.

    NOTE: this targets only the text-box inside the sidebar anchor — preserves
    the anchor/textbox XML shell.
    """
    # The sidebar is a floating textbox: <w:sdtContent><w:p>...<wps:txbx><w:txbxContent>... paragraphs here ...</w:txbxContent></wps:txbx>...
    NS_WPS = "{http://schemas.microsoft.com/office/word/2010/wordprocessingShape}"
    NS_V = "{urn:schemas-microsoft-com:vml}"
    txbx_contents = (
        list(sdt.iter(f"{NS_WPS}txbx"))
        + list(sdt.iter(f"{NS_V}textbox"))
    )
    for txbx in txbx_contents:
        tc = txbx.find(".//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}txbxContent")
        if tc is None:
            continue
        for p in list(tc):
            tc.remove(p)
        for role, text in lines:
            p = etree.SubElement(tc, f"{_W}p")
            if text:
                r = etree.SubElement(p, f"{_W}r")
                if role == "name":
                    rpr = etree.SubElement(r, f"{_W}rPr")
                    etree.SubElement(rpr, f"{_W}b")
                t = etree.SubElement(r, f"{_W}t")
                t.set(f"{{http://www.w3.org/XML/1998/namespace}}space", "preserve")
                t.text = text
```

- [ ] **Step 10.4: In `update-briefkopf.py` die neue Funktion verwenden**

Ersetze in `sync_template`:

```python
from scripts.briefkopf_lib.sync import sync_sdts_with_sidebar_rendering
import json

# at top of module:
KANZLEI_JSON = REPO / "gutachtenvorlagen" / "kanzlei.json"

# in sync_template, replace "sync_sdts(target, master, BRIEFKOPF_SDT_TAGS)" with:
    kanzlei = json.loads(KANZLEI_JSON.read_text("utf-8"))
    sync_sdts_with_sidebar_rendering(target, master, kanzlei)
```

- [ ] **Step 10.5: Sync mit Partner-Rendering**

```bash
python scripts/update-briefkopf.py --all
```

- [ ] **Step 10.6: MILESTONE 5 — visueller Test**

```bash
open standardschreiben/templates/Bankenanfrage.docx
```

Erwartung: Partner-Sidebar zeigt die echten aktuellen Partner aus `kanzlei.json` (nicht die evtl. älteren Master-Werte).

- [ ] **Step 10.7: Commit**

```bash
git add scripts/briefkopf_lib/sidebar_render.py scripts/briefkopf_lib/sync.py scripts/update-briefkopf.py scripts/briefkopf_lib/__tests__/test_sidebar_render.py
git add gutachtenvorlagen/*.docx standardschreiben/templates/*.docx
git commit -m "feat(briefkopf): render partner sidebar from kanzlei.json at sync time"
```

---

## Task 11: 3-Viewer-Akzeptanztest + README

**Files:**
- Create: `briefkopf/README.md`

**Context:** Definition-of-Done laut Spec: Briefkopf muss in Word Desktop UND Word Online UND LibreOffice korrekt rendern. Außerdem braucht TBS eine kurze Anleitung, wie der Briefkopf gepflegt wird.

- [ ] **Step 11.1: README.md für TBS**

```markdown
# Briefkopf

Zentraler Briefkopf für alle Gutachten und Standardschreiben.

## Pflege durch TBS

### Partner ändern
`gutachtenvorlagen/kanzlei.json` editieren (Partner hinzufügen/entfernen/Titel ändern).

Danach: `python scripts/update-briefkopf.py --all`

### Layout-Änderung (Logo, Dekobars, Footer-Text, Siegel)
`briefkopf/briefkopf-master.docx` in Word öffnen, ändern, speichern.

Danach: `python scripts/update-briefkopf.py --all`

### Inhaltssteuerelemente im Master
Vier Content Controls mit den Tags:
- `briefkopf-sidebar` — Partner-Textbox
- `briefkopf-siegel-dekra` — DEKRA-Siegel
- `briefkopf-siegel-vid` — VID-Siegel
- `briefkopf-sachbearbeiter` — Sachbearbeiter-Block mit KI_*-Platzhaltern

**Nicht löschen, nicht außerhalb verschieben.** Inhalt innerhalb darf geändert werden.

## Rollback
Jedes Template hat ein `*.backup.docx` mit der Version vor dem ersten Sync.
```

- [ ] **Step 11.2: 3-Viewer-Test manuell**

Öffne je ein Anschreiben + ein Gutachten in:
- Word Desktop (Mac/Win)
- Word Online (SharePoint, oder docx hochladen in OneDrive)
- LibreOffice Writer (`soffice --writer standardschreiben/templates/Bankenanfrage.docx`)

Prüfen: Sidebar sichtbar und korrekt positioniert, Body umfließt nicht kaputt, Footer auf allen Seiten. Screenshots in ein temp-Verzeichnis für spätere Referenz.

- [ ] **Step 11.3: Commit**

```bash
git add briefkopf/README.md
git commit -m "docs(briefkopf): TBS usage README"
```

- [ ] **Step 11.4: Update memory + wiki**

Memory-Update:

```bash
# Update briefkopf plan memory to reflect new approach
```

Aktualisiere `~/.claude/projects/-Users-thorsten-KlareProzesse-de-TBS-insolvenz-extraktor/memory/project_briefkopf_plan.md` von "Gutachten-only" auf "unified, 13 templates, SDT-wrapper".

---

## Self-Review

**Spec coverage:**
- Abschnitt 1 (Master-Struktur): Task 3 erzeugt Master mit 4 SDT-Wraps ✅
- Abschnitt 2 (Ziel-Templates): Tasks 7-9 synchronisieren alle 13 Templates ✅
- Abschnitt 3 (Sync-Skript, 10 Schritte): Tasks 4-7 decken SDT-Replace, Header/Footer, Media, Content-Types, sectPr ab ✅
- Abschnitt 4 (Migration): Task 9 Gutachten-Cleanup ✅; Anschreiben via sectPr+titlePg-Setup implizit in Task 6 ✅
- Abschnitt 5 (Runtime unverändert): Keine Code-Änderung am Backend ✅
- Abschnitt 6 (Dateien): Alle neuen Dateien + geänderten Templates abgedeckt ✅
- Abschnitt 7 (Tests/Verifikation): Unit tests in Tasks 1-6, Akzeptanzkriterien in Milestones + Task 11 ✅

**Placeholder scan:** durchgesehen — keine TBDs, keine "handle edge cases", jede Test-/Impl-Stelle enthält echten Code.

**Type consistency:**
- `BRIEFKOPF_SDT_TAGS` einheitliche Liste aus 4 Strings ✅
- `rid_map` dict mit Keys `first-header`, `first-footer`, `default-header`, `default-footer` — in `patch_document_rels` und `ensure_section_properties` konsistent ✅
- `DocxBundle` API (`read`, `read_part`, `write_part`, `has_part`, `delete_part`, `save`, `list_parts`) einheitlich in allen Modulen ✅
- `render_sidebar_lines` liefert `list[tuple[Role, str]]` — in `_render_lines_into_sdt` korrekt konsumiert ✅
