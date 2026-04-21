# Add-Document Test Set

Source: `Gerichtsakte (elektronisch).pdf` (87 pages, natürliche Person, D&S Consulting / Etienne Steveninck)

## Reference

- `00-vollstaendige-akte.pdf` — Full 87 pages. Extract this first as the benchmark baseline (expected: ~52 fields via native Anthropic, ~24-27 via field packs).

## Test Set 1: Missing Beschluss

Scenario: Gerichtsakte arrives without the court order. Beschluss comes later.

- `01-base-ohne-beschluss.pdf` (80 pages) — Everything except Beschluss/Verfügung/Ermittlungsanfragen
- `01a-supplement-beschluss.pdf` (2 pages) — Court order with Aktenzeichen, Gericht, Beschlussdatum, Gutachterbestellung, Sicherungsmaßnahmen
- `01b-supplement-verfuegung-ermittlung.pdf` (5 pages) — Verfügung + GV/Melde/Grundbuch-Anfragen

**Expected after adding 01a:**
- NEW: verfahrensdaten.aktenzeichen, beschlussdatum, gutachterbestellung.*
- NEW: sicherungsmassnahmen

**Expected after adding 01b:**
- NEW/UPDATE: ermittlungsergebnisse fields (anfragen an GV, Meldeamt, Grundbuch)

## Test Set 2: Missing Gläubigerdokumente

Scenario: Base extraction has Antrag + Beschluss but no creditor documents.

- `02-base-ohne-glaeubiger.pdf` (52 pages) — Antrag, Fragebogen, Vermögen, Beschluss
- `02-supplement-glaeubiger.pdf` (30 pages) — Sparkasse, Finanzamt, Commerzbank, Mercedes-Benz, Gemeindekasse, Steuerberater

**Expected after adding supplement:**
- NEW: mehrere einzelforderungen (Sparkasse, Finanzamt, Commerzbank, etc.)
- UPDATE: forderungen.gesamtforderungen if computed

## Test Set 3: Incremental Build-Up

Scenario: Documents arrive one by one. Start with just the Antrag.

- `03-base-nur-antrag.pdf` (6 pages) — Insolvenzantrag + Fragebogen only
- `03a-supplement-forderungsverzeichnis.pdf` (5 pages) — Gläubiger-/Forderungsverzeichnis
- `03b-supplement-vermoegen.pdf` (19 pages) — Vermögensübersicht + all Ergänzungsblätter
- `03c-supplement-beschluss-verfuegung.pdf` (4 pages) — Beschluss + Verfügung

**Expected cumulative:**
1. Base: Schuldner name/adresse, Familienstand, basic Verfahrensdaten (from Antrag)
2. +03a: einzelforderungen array populated
3. +03b: aktiva.positionen populated (Bankguthaben, Einkommen, Hausrat, etc.)
4. +03c: Aktenzeichen, Gericht, Beschlussdatum, Gutachterbestellung

## Benchmarking

Compare: fields found after adding all supplements vs `00-vollstaendige-akte.pdf` full extraction.
The incremental approach should reach ≥90% of the full extraction's field count.
