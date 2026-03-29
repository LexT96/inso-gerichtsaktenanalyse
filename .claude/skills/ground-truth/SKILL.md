---
name: ground-truth
description: Create a ground truth from a PDF, then compare against tool extraction. Usage: /ground-truth path/to/akte.pdf
---

# Ground Truth erstellen & vergleichen

Manually reads a court file PDF, creates a ground truth extraction, then runs the tool and compares field-by-field.

## Usage

The user provides a PDF path. If no path given, ask for it.

## Steps

### Phase 1: Ground Truth erstellen

1. **Read the PDF** page by page (use `Read` tool with `pages` parameter, 10 pages at a time).

2. **Extract ALL data manually** as a German insolvency expert. Create a markdown table for each section:

   **Verfahrensdaten:** Aktenzeichen, Gericht, Richter, Antragsdatum, Beschlussdatum, Antragsart, Eröffnungsgrund, Zustellungsdatum, Verfahrensstadium, Verfahrensart

   **Schuldner:** Name, Vorname (if natürliche Person), Geburtsdatum, Adresse, Firma, Rechtsform, Betriebsstätte, HRB, Familienstand, Kinder, Ehegatte

   **Antragsteller:** Name, Adresse, Ansprechpartner, Telefon, Fax, Email, Betriebsnummer, IBAN, BIC

   **Forderungen:** Each creditor with: Gläubiger, Art, Betrag, Zeitraum, Sicherheiten. Plus: Gesamtforderung, betroffene Arbeitnehmer

   **Ermittlungsergebnisse:** Grundbuch, Gerichtsvollzieher, Vollstreckungsportal, Meldeauskunft

   **Besonderheiten:** Anfechtbare Vorgänge, Adressdiskrepanzen, Widersprüche zwischen Dokumenten, Fristen

   For each field, note the **exact page** where found.

3. **Flag tricky spots** the tool might get wrong:
   - Zustellungsdatum (PZU-Stempel vs. Briefdatum)
   - Betriebsstätte vs. Privatanschrift bei Einzelunternehmern
   - Widersprüchliche Beträge (Antrag vs. Leistungsbescheid)
   - Felder die bei juristischen Personen irrelevant sind

### Phase 2: Tool-Extraktion

4. **Run the extraction** using /verify-akte skill or:
```bash
cd backend && npx tsx src/scripts/verify-extraction.ts "{pdf_path}" 2>&1 | grep -v "Warning: Ran out of space"
```

### Phase 3: Vergleich

5. **Compare field-by-field** in a table:

| Feld | Ground Truth | Tool | Status |
|------|-------------|------|--------|
| Aktenzeichen | 23 IN 165/25 | 23 IN 165/25 | ✅ |
| Zustellungsdatum | 03.12.2025 (PZU) | 27.11.2025 | ❌ Briefdatum statt PZU |

Status markers:
- ✅ Korrekt
- ⚠️ Teilweise korrekt (richtige Info, falsche Quelle)
- ❌ Falsch
- ○ Fehlt (sollte extrahiert worden sein)
- — Korrekt leer (Information nicht in Akte)

6. **Calculate score**: Count correct / total relevant fields × 100

7. **Identify prompt improvements** needed:
   - Which fields were wrong and why
   - Which fields were missed and why
   - Specific prompt text changes to fix the issues

### Phase 4: Empfehlungen

8. **Output concrete prompt fixes** that can be applied to `backend/src/services/anthropic.ts`
