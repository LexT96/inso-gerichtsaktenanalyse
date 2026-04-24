# Unified Briefkopf for Gutachten + Anschreiben

**Status:** Approved design, ready for implementation planning
**Date:** 2026-04-24
**Revised:** 2026-04-24 — Nach Codex-Review von A1-original (Sidebar → Header) zu A1-pragmatic (Sidebar bleibt body-anchored, SDT-Wrapper) gewechselt
**Supersedes:** `memory/project_briefkopf_plan.md` (2026-04-16 — Gutachten-only scope)

## Goal

TBS hat aktuell 13 DOCX-Templates (3 Gutachten + 10 Anschreiben). Die Gutachten haben einen teilweisen Briefkopf direkt in den Template-Body eingebacken; die 10 Anschreiben haben gar keinen Briefkopf. Wir wollen:

1. Alle 13 Templates tragen denselben, visuell identischen Briefkopf (Logo, Partner-Sidebar, Footer).
2. Es gibt genau **eine** Quelle für das Briefkopf-Layout — TBS soll Logo, Partner, Footer-Text an einer Stelle bearbeiten und mit einem Befehl in alle Templates propagieren können.
3. Die erste Seite jedes Templates bleibt im Body-Bereich **frei editierbar** — jedes Anschreiben und jedes Gutachten hat seinen eigenen Einleitungstext, eigene Empfängeradresse, eigene Betreffzeile.

## Non-Goals

- Kein Runtime-Merge von DOCX-Dateien. Laufzeit bleibt: ein Template rein, ein fertiges DOCX raus.
- Keine neue Datenbank-Tabelle. Firmenstammdaten bleiben in `gutachtenvorlagen/kanzlei.json`.
- Kein automatisches Logo-Update via API. TBS ändert Layout manuell in Word, committet den Master.
- Kein PDF-Rendering / kein LibreOffice im Sync-Pfad.

## Design-Iteration: warum SDT-Wrapper statt Header-Umzug

Eine erste Version dieses Specs verschob die Partner-Sidebar aus dem Body in `word/header1.xml`, um den Template-Body garantiert unberührt zu lassen. Ein Codex-Review wies auf Risiken hin:

1. **Floating-Frame-Rendering im Header**: Body-Text-Umfluss um einen in `header1.xml` anchored frame (`wrapSquare` über Story-Grenzen) ist in Word Desktop meist OK, aber in Word Online und LibreOffice unvorhersehbar.
2. **Anchor-Kontext-Wechsel**: `relativeFrom="column"` bei `wp:positionH` hat im Header einen anderen Kontext als im Body; der Anchor müsste neu authored werden statt nur XML-verschoben.
3. **Media-Lifecycle**: Pauschales Leeren von `word/media/*` im Ziel-Template würde Body-eigene Bilder (z.B. rId8-10 in Gutachten) zerstören.
4. **Runtime-Annahme**: `letterGenerator.ts:291-306` verarbeitet aktuell nur `word/document.xml`, nicht Header/Footer — die Original-Annahme "kein Runtime-Change" wäre für Anschreiben falsch gewesen.

Entscheidung nach Review: **A1-pragmatic mit SDT-Wrapper.** Sidebar + Siegel + Sachbearbeiter-Block bleiben body-anchored wie im aktuellen Master. Sie werden in `<w:sdt>` Content Controls mit eindeutigen Tags gewrapped, damit das Sync-Skript sie exakt adressieren kann und der Template-Autor in Word ein visuelles Signal hat ("Inhaltssteuerelement, zentral gepflegt — nicht anfassen"). Body außerhalb der SDTs bleibt garantiert unberührt. Da alle `KI_*`-Platzhalter in Body-SDTs leben, bleibt `letterGenerator.ts` unverändert.

## Architektur-Übersicht

```
                    ┌────────────────────────────────┐
                    │  briefkopf/briefkopf-master.docx│  (1 Datei, TBS pflegt in Word)
                    │  + kanzlei.json (Daten)        │
                    └──────────────┬─────────────────┘
                                   │
                    scripts/update-briefkopf.py --all
                                   │
           ┌───────────────────────┼───────────────────────┐
           ▼                       ▼                       ▼
   gutachtenvorlagen/      standardschreiben/       (13 Ziel-Templates)
   Gutachten_*.docx (3)    templates/*.docx (10)    ← SDT-Inhalte im Body
                                                      + header/footer getauscht
           │                       │
           ▼                       ▼
   Runtime: gutachtenGenerator.ts / letterGenerator.ts
   füllt KI_*/FELD_* in allen Parts → fertiges DOCX
```

## 1. Master-Datei: `briefkopf/briefkopf-master.docx`

**Speicherort:** `briefkopf/briefkopf-master.docx` (neues Top-Level-Verzeichnis; liegt in Git).

**Basis:** Der existierende `/Users/thorsten/Downloads/Briefkopf_TBS.docx` wird als Master übernommen. Einmaliger Refactor in Word:

- Empfängeradresse, Absenderzeile, Empfänger-Freitext-Body werden entfernt (diese gehören in die jeweiligen Templates).
- Die vier body-anchored Elemente (Partner-Sidebar-Textbox, DEKRA-Siegel, VID-Siegel, Sachbearbeiter-Block) werden in `<w:sdt>` Content Controls gewrappt, je mit einem stabilen Tag.

**Body-Struktur des Masters nach Refactor:**

| SDT-Tag | Inhalt | Typ |
|---|---|---|
| `briefkopf-sidebar` | Partner-Textbox (wp:anchor 5.5×17.8 cm, wrapSquare) mit `{{PARTNER_SIDEBAR}}`-Marker | floating text frame |
| `briefkopf-siegel-dekra` | DEKRA ISO-9001-Siegel (rId für `image1.png`) | floating image |
| `briefkopf-siegel-vid` | VID-CERT-Siegel (rId für `image2.jpeg`) | floating image |
| `briefkopf-sachbearbeiter` | Absenderzeile + Sachbearbeiter-Block mit `KI_Sachbearbeiter_Name`, `KI_Sachbearbeiter_Durchwahl`, `KI_Sachbearbeiter_Email`, `KI_Mein_Zeichen`, `KI_Standort_Telefon` | inline Absatz-Gruppe |

**Header/Footer-Struktur:**

| DOCX-Part | Inhalt | Geltungsbereich |
|---|---|---|
| `word/header1.xml` | Logo-Dekobar (image4.emf) — floating anchor mit relativeFrom="page" | Seite 1 |
| `word/header2.xml` | Leer (oder minimale Kopfzeile) | Seite 2+ |
| `word/footer1.xml` | Footer-Dekobar (image3.emf), "Seite X von Y", Partnerschaftsregister-Zeile, Bank-Zeile | Seite 1 |
| `word/footer2.xml` | Identisch zu footer1.xml | Seite 2+ |

**Platzhalter im Master:**

- Partner-Sidebar: enthält Marker-Paragraph `{{PARTNER_SIDEBAR}}`, den das Sync-Skript durch die generierten Partner-/Standort-Paragraphen aus `kanzlei.json` ersetzt.
- Partnerschaftsregister-Zeile im Footer: statisch aus `kanzlei.json` (`kanzlei.partnerschaftsregister`), vom Sync-Skript eingesetzt.
- `KI_Sachbearbeiter_*` im Sachbearbeiter-SDT: bleibt unverändert, zur Runtime vom Verwalter-Profil gefüllt.

## 2. Ziel-Templates (13 Stück)

**Gemeinsame Anforderungen nach dem Sync:**

1. Body enthält am Anfang die 4 SDTs (`briefkopf-sidebar`, `briefkopf-siegel-dekra`, `briefkopf-siegel-vid`, `briefkopf-sachbearbeiter`) in derselben Reihenfolge und Form wie im Master.
2. Body-Inhalt hinter den SDTs ist Template-spezifisch (Empfänger-Adressblock, Betreff, Fließtext, Grußformel, Unterschrift) — vom Sync nie angefasst.
3. `<w:sectPr>` am Body-Ende hat `<w:titlePg/>` + Refs auf alle vier Header/Footer.
4. Header/Footer/Master-Media bitgenau aus dem Master übernommen.

**Konkreter Beispiel-Bodyaufbau eines Anschreibens nach Sync:**

```
<w:body>
  <w:sdt w:tag="briefkopf-sidebar">...</w:sdt>           ← zentral gepflegt
  <w:sdt w:tag="briefkopf-siegel-dekra">...</w:sdt>      ← zentral gepflegt
  <w:sdt w:tag="briefkopf-siegel-vid">...</w:sdt>        ← zentral gepflegt
  <w:sdt w:tag="briefkopf-sachbearbeiter">...</w:sdt>    ← zentral gepflegt

  <w:p>FELD_Bet_Empfaenger_Name</w:p>                    ← Template-frei
  <w:p>FELD_Bet_Empfaenger_Adresse</w:p>
  <w:p>Betreff: Anfrage zu Kontoverbindung ...</w:p>
  <w:p>FELD_Bet_AnredeHoeflichOV</w:p>
  ...freier Brieftext mit FELD_* / KI_* ...
  <w:p>FELD_Bet_GrussBriefende</w:p>
  <w:p>FELD_Verwalter_Unterzeichner</w:p>

  <w:sectPr> ... w:titlePg ... header/footer refs ... </w:sectPr>
</w:body>
```

## 3. Sync-Skript: `scripts/update-briefkopf.py`

**Funktion:** Propagiert Master → 13 Ziel-Templates. Ersetzt ausschließlich: die vier SDT-Blöcke im Body (per Tag-Match), Header/Footer-XMLs, Master-referenzierte Medien. Body außerhalb der SDTs bleibt unberührt.

**Aufruf:**

```bash
python scripts/update-briefkopf.py --all
python scripts/update-briefkopf.py --only gutachten
python scripts/update-briefkopf.py --only anschreiben
python scripts/update-briefkopf.py --template Bankenanfrage
python scripts/update-briefkopf.py --all --dry-run     # zeigt Diff-Summary pro Template
```

**Ablauf pro Ziel-Template:**

1. Template als ZIP öffnen.
2. Backup (`<template>.backup.docx`), falls noch keins existiert.
3. **SDT-Replace im Body:**
   - Für jeden der 4 Briefkopf-Tags: finde `<w:sdt>`-Block mit passendem `<w:tag>`-Child im Ziel-`document.xml`, ersetze durch den entsprechenden SDT-Block aus Master-`document.xml`.
   - Wenn SDT fehlt (wurde versehentlich gelöscht): logge Warning, überspringe diesen Tag. Prepare-Skript hat einmalig alle SDTs eingefügt — fehlende SDT deutet auf manuellen Eingriff hin.
   - Alles im Body außerhalb der 4 SDTs bleibt byte-identisch.
4. **Partner-Sidebar-Rendering:** Im gerade eingesetzten `briefkopf-sidebar`-SDT ersetze `{{PARTNER_SIDEBAR}}` durch die generierten Partner-/Standort-Paragraphen aus `kanzlei.json`.
5. **Partnerschaftsregister-Einsetzung:** Im Footer ersetze entsprechenden Marker durch `kanzlei.partnerschaftsregister`.
6. **Header/Footer-Part-Replace:**
   - Lösche alte `word/header1.xml`, `word/header2.xml`, `word/footer1.xml`, `word/footer2.xml` und zugehörige `_rels`.
   - Kopiere aus Master die gleichen Parts inkl. Rels ein.
7. **Media-Import (kollisionssicher):**
   - Bestimme, welche Medien der Master wirklich nutzt (via Master-Rels-Scan über alle kopierten Parts + SDT-Rels).
   - Bestimme, welche Medien das Ziel eigenständig nutzt (alle Rels-Targets außerhalb der übernommenen Master-Rels).
   - Import jedes Master-Mediums: bei Namenskollision umbenennen (`image1.png` → `image_briefkopf_1.png`), Rels-Targets in den importierten Rels entsprechend patchen.
   - Kein pauschales `word/media/*`-Löschen.
8. **sectPr-Update in document.xml:** Ausschließlich das finale `<w:sectPr>` wird auf titlePg + korrekte Header/Footer-rIds gesetzt. Alle `<w:p>`/`<w:tbl>` darüber bleiben byte-identisch.
9. **[Content_Types].xml + document.xml.rels:** Um neu hinzugekommene Parts und Media erweitern, ohne bestehende Einträge zu entfernen.
10. Template als ZIP zurückschreiben.

**Partner-Sidebar-Rendering** (aus `kanzlei.json`):

- Kategorien `PARTNER`, `ANGESTELLTE`, `OF COUNSEL` in fixer Reihenfolge
- Je Person: Name, Titel (mehrzeilig), ggf. Fachanwalt-Qualifikationen
- Sektion `STANDORTE`: alle Standorte mit nicht-leerer `adresse`
- Abschluss: Website-Zeile, Partnerschaftsregister-Zeile
- Als Word-Paragraphen mit existierendem Styling aus dem Master-SDT

**Body-Schutz (invariante):**

Außerhalb der vier SDT-Blöcke und des finalen `<w:sectPr>` wird `word/document.xml` byte-identisch belassen. Das Skript enthält eine Assertion: Falls ein Diff außerhalb dieser geschützten Bereiche auftritt, wird die Datei nicht geschrieben und es wird ein Fehler geloggt.

**Safety:**

- Validierung vor jedem Lauf: Master enthält alle 4 SDT-Tags + alle 4 Header/Footer-Parts + `titlePg`.
- `--dry-run` zeigt pro Ziel: welche SDTs ersetzt werden, welche Header/Footer/Media sich ändern, Text-Diff-Summary.
- Backup nur beim ersten Lauf — nachfolgende Syncs überschreiben nicht das Backup.

## 4. Migration der 10 Anschreiben + Cleanup der 3 Gutachten

**Einmaliges Vorbereitungs-Skript:** `scripts/prepare-templates-for-briefkopf.py`

Läuft einmalig vor dem ersten `update-briefkopf.py`, dann gelöscht.

**Für alle 10 Anschreiben (aktuell body-only, keine Header/Footer):**

1. Öffne Template.
2. Füge am Body-Anfang die 4 SDT-Stubs ein (leer oder mit Master-Inhalt — wird direkt danach vom Sync gefüllt).
3. Füge/ersetze `<w:sectPr>` am Body-Ende mit `<w:titlePg/>` + Refs auf die vier Header/Footer (rIds werden vom Sync final gesetzt).
4. `<w:pgMar>`: rechten Rand anpassen, so dass der Body-Textfluss nicht unter die Sidebar (rechts 5.5 cm) läuft. Empfohlen: `w:right` ≈ 5500 twip auf Seite 1 via `titlePg` (oder Sidebar links positionieren, dann `w:left` entsprechend).

**Für die 3 Gutachten (haben bereits Partial-Briefkopf im Body):**

1. Identifiziere die bestehenden Briefkopf-Paragraphen am Body-Anfang anhand Marker-Texten (`"Kornmarkt"`, `"Sachbearbeiter/in"`, `"KI_Sachbearbeiter_"`, `"Mein Zeichen"`).
2. Lösche diese Paragraphen.
3. Füge stattdessen die 4 SDT-Stubs wie bei den Anschreiben ein.
4. Sonst verbleibt der Body des Gutachten unverändert (Inhaltsverzeichnis, Kapitelstruktur, Slot-Platzhalter).

**Verifikation nach Migration:**

- Manuell: TBS öffnet je ein Gutachten und ein Anschreiben in Word Desktop UND Word Online UND LibreOffice. Prüft visuell: Briefkopf sauber auf Seite 1, Body nicht mit Sidebar überlappt, Footer auf allen Seiten.
- Viewer-Akzeptanz ist Bestandteil der Definition-of-Done — Codex hat auf Render-Risiken gerade in Word Online / LibreOffice hingewiesen. Kein Ship ohne positiven 3-Viewer-Test.

## 5. Runtime — keine Änderungen

`letterGenerator.ts` (scannt aktuell `word/document.xml`) und `gutachtenGenerator.ts` (scannt `document.xml + header1/2/3 + footer1/2/3`) funktionieren beide unverändert weiter:

- Alle `KI_*`/`FELD_*`-Platzhalter leben im Body innerhalb der SDTs — werden vom bestehenden `document.xml`-Scan beider Generatoren gefunden.
- Header/Footer des Masters enthalten keine `KI_*`-Platzhalter (nur statischer Text + Logo + Seitenzahlen) — keine Runtime-Verarbeitung nötig.
- SDT-Wrapper sind bei der XML-Text-Suche transparent: `<w:sdtContent>` enthält normale `<w:p>`/`<w:t>`, die vom bestehenden `processDocxParagraphs` gefunden werden.

**Keine Änderung** an:

- `backend/src/utils/letterGenerator.ts`
- `backend/src/utils/gutachtenGenerator.ts`
- Routes, Database-Schema, Frontend.

## 6. Dateien & Änderungs-Inventar

**Neu:**

- `briefkopf/briefkopf-master.docx` — Master-Layout mit SDT-gewrappten Briefkopf-Elementen
- `briefkopf/README.md` — Bedienungsanleitung für TBS (welche SDTs gibt es, was darf geändert werden, wie sync laufen lassen)
- `scripts/update-briefkopf.py` — erweiterter Sync (ersetzt das bestehende Gutachten-only Script)
- `scripts/prepare-templates-for-briefkopf.py` — einmalige Migration

**Geändert:**

- `gutachtenvorlagen/Gutachten Muster natürliche Person.docx` — Body-Briefkopf-Duplikate entfernt, 4 SDTs eingefügt, Header/Footer/Media vom Sync gesetzt
- `gutachtenvorlagen/Gutachten Muster juristische Person.docx` — dito
- `gutachtenvorlagen/Gutachten Muster Personengesellschaft.docx` — dito
- `standardschreiben/templates/*.docx` (10 Dateien) — 4 SDTs am Body-Anfang, sectPr/pgMar angepasst, Header/Footer/Media vom Sync gesetzt

**Unverändert:**

- `gutachtenvorlagen/kanzlei.json` — Struktur bleibt; wird vom Sync-Skript gelesen
- `gutachtenvorlagen/gutachten-mapping.json`
- `standardschreiben/platzhalter-mapping.json`
- `backend/src/utils/letterGenerator.ts`
- `backend/src/utils/gutachtenGenerator.ts`
- Alle Routes
- Database-Schema

## 7. Tests & Verifikation

**Unit-Tests:**

- `scripts/__tests__/test_update_briefkopf.py`:
  - Sync auf Fixture-Template. Erwartung: Body außerhalb SDTs byte-identisch, SDT-Inhalte exakt aus Master, `{{PARTNER_SIDEBAR}}` ersetzt.
  - Body-Schutz-Invariante: Fixture mit manipuliertem Body (Paragraph nach SDTs geändert) — Skript darf diesen Paragraph nicht überschreiben.
  - Media-Kollision: Fixture mit eigenem `image1.png` im Body — nach Sync existieren beide Bilder unter unterschiedlichen Namen.
- `scripts/__tests__/test_prepare_templates.py`: Cleanup entfernt nur die Briefkopf-Markertexte, keinen Body-Text.

**Manuelle Verifikation (Akzeptanzkriterien):**

1. `python scripts/update-briefkopf.py --all` läuft ohne Fehler über alle 13 Templates.
2. Backup-Dateien `*.backup.docx` existieren.
3. Jedes Template öffnet in Word fehlerfrei (keine "Repair"-Dialoge).
4. Visuell auf Seite 1: Logo oben, Partner-Sidebar an der vorgesehenen Seite, Sachbearbeiter-Block rechts, Body-Text umschließt korrekt — keine Überlappung.
5. Visuell auf Seite 2: Nur Footer, kein Logo, keine Sidebar.
6. Footer auf allen Seiten: Partnerschaftsregister + Bank + "Seite X von Y".
7. **3-Viewer-Test (Akzeptanz):** Punkte 3-6 gelten in Word Desktop, Word Online und LibreOffice.
8. `kanzlei.json` um einen Partner erweitern, `update-briefkopf.py --all` erneut, alle 13 Templates zeigen neuen Partner.
9. End-to-End: Extraction laufen lassen, Gutachten + Bankenanfrage generieren, beide enthalten Briefkopf, `KI_Sachbearbeiter_*` gefüllt, Body hat Case-Daten.

## 8. Offene Punkte / Entscheidungen zur Implementierungszeit

- **Sidebar-Seite**: links oder rechts? Im aktuellen Master sitzt sie rechts (relativeFrom="column" mit positiver X-Koordinate). Beibehalten.
- **Header2-Inhalt**: leer lassen oder minimale Kopfzeile "Prof. Dr. Dr. Thomas B. Schmidt Insolvenzverwalter — Seite {PAGE}"? TBS-Entscheidung vor dem Master-Refactor.
- **SDT-Placeholder-Text**: jedes SDT bekommt einen `<w:showingPlcHdr/>`-Mode und Placeholder-Text, der in Word sichtbar macht "Partner-Sidebar (zentral gepflegt — nicht anfassen)". Konkrete Wording mit TBS abstimmen.

## 9. Out-of-Scope / Future Work

- Zweiter Master für anderen Standort (z.B. Zell mit eigenem Sachbearbeiter-Default) — aktuell 1 Master, TBS überschreibt Sachbearbeiter-Werte pro Gutachten.
- Corporate-Identity-Varianten (z.B. für Konzern-Mandanten mit anderer Farbgebung) — nicht geplant.
- PDF-Export direkt aus Backend — derzeit nur DOCX, PDF via Word/TBS.
