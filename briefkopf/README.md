# Briefkopf

Zentraler Briefkopf für die 13 DOCX-Vorlagen (3 Gutachten + 10 Anschreiben).

## Was hier liegt

- `briefkopf-master.docx` — Master-Vorlage. Enthält den kompletten Briefkopf (Logo,
  Empfänger-Block mit `FELD_*`-Platzhaltern, Sachbearbeiter-Block, floating Sidebar
  mit Partnerliste, Siegel DEKRA + VID, "per beA"-Zeile, Ort/Datum-Zeile) gewrapped
  in einer einzigen `<w:sdt w:tag="briefkopf-block">`. Wird programmatisch aus
  `gutachtenvorlagen/Gutachten Muster natürliche Person.docx` erzeugt.

## Pflege durch TBS

### Partner / Standorte ändern (häufig)

`gutachtenvorlagen/kanzlei.json` editieren — Partner hinzufügen/entfernen, Titel
ändern, Standort hinzufügen.

Danach in der Repo-Wurzel:

```bash
python scripts/update-briefkopf.py --all
```

Der Sync rendert die Sidebar in alle 13 Templates aus `kanzlei.json` neu. Gutachten
behalten ihren bestehenden Briefkopf (nur Sidebar-Refresh), Anschreiben bekommen
den kompletten Briefkopf-Block frisch eingespielt.

### Layout-Änderung (selten)

Layout-Änderungen am Briefkopf werden im **Gutachten-Muster** gemacht, nicht in
`briefkopf-master.docx`:

1. `gutachtenvorlagen/Gutachten Muster natürliche Person.docx` in Word öffnen
2. Briefkopf-Bereich (Empfänger, Sachbearbeiter, Sidebar, Siegel, Ort/Datum)
   ändern und speichern
3. Master neu erzeugen:
   ```bash
   python scripts/create_briefkopf_master.py \
     --source "gutachtenvorlagen/Gutachten Muster natürliche Person.docx" \
     --output briefkopf/briefkopf-master.docx
   ```
4. Sync auf alle Templates anwenden:
   ```bash
   python scripts/update-briefkopf.py --all
   ```

## Backup & Rollback

Beim ersten Sync wird pro Template eine `*.backup.docx` neben der Vorlage angelegt
(einmalig — folgende Syncs überschreiben das Backup nicht). Wenn du eine
Vorlage zurücksetzen willst:

```bash
cp standardschreiben/templates/Bankenanfrage.backup.docx \
   standardschreiben/templates/Bankenanfrage.docx
```

## Was der Sync NICHT anfasst

- Body-Inhalt eines Templates **außerhalb** des `briefkopf-block` SDT bleibt unberührt
- Eigene Bilder im Body eines Anschreibens (z.B. eingebundene Diagramme) — werden
  nicht überschrieben (Master-Medien werden mit `briefkopf_`-Präfix importiert,
  Body-Bilder behalten ihren Originalnamen)

## Platzhalter im Briefkopf

Folgende `FELD_*` werden vom Letter-Generator zur Generierungszeit gefüllt:

- `FELD_Gericht_Ort`, `FELD_Gericht_Adresse`, `FELD_Gericht_PLZ_Ort` — Empfänger Insolvenzgericht
- `FELD_Sachbearbeiter_Name`, `FELD_Sachbearbeiter_Durchwahl`, `FELD_Sachbearbeiter_Email`
- `FELD_Standort_Telefon`
- `FELD_Mein_Zeichen`, `FELD_Ihr_Zeichen`
- `FELD_Briefkopf_Ort`, `FELD_Briefkopf_Datum`

Felder ohne Mapping in `standardschreiben/platzhalter-mapping.json` werden vom
Letter-Generator entfernt, erscheinen also als Leerstellen — ergänze die Mapping
oder fülle in Word manuell, falls nötig.

## Troubleshooting

**Sidebar zeigt veraltete Partner**: Cache-Problem in Word — Datei schließen,
Sync nochmal laufen lassen, neu öffnen.

**Doppelter Briefkopf in einem Anschreiben**: Sync wurde versehentlich vor einem
Body-Edit gemacht der den briefkopf-block SDT verschoben hat. Aus Backup
zurückspielen und Sync neu.

**Test-Suite**:

```bash
python -m pytest scripts/briefkopf_lib/
```

Sollte 14 grüne Tests zeigen.
