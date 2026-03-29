---
name: verify-akte
description: Run full extraction pipeline on a PDF and display the verification report. Usage: /verify-akte path/to/akte.pdf
---

# Akte verifizieren

Runs the full extraction pipeline (Sonnet + Extended Thinking + Semantic Verification) on a PDF and displays the structured verification report.

## Usage

The user provides a PDF path as argument. If no path given, ask for it.

## Steps

1. **Run the verify script:**

```bash
cd /Users/thorsten/KlareProzesse.de/TBS/insolvenz-extraktor/backend && npx tsx src/scripts/verify-extraction.ts "{pdf_path}" 2>&1 | grep -v "Warning: Ran out of space" | grep -v "^\[dotenv"
```

Run this in the background (`run_in_background: true`) since it takes 2-5 minutes.

2. **When complete**, read the output file and extract the report section (everything between `══════` markers).

3. **Present the report** to the user with a brief summary:
   - Abdeckung (X/Y Felder, Z%)
   - Standardanschreiben status (bereit/fehlt/entfällt counts)
   - Key findings from Zusammenfassung
   - Any Risiken & Hinweise

4. **If the user has a previous ground truth**, compare field-by-field.

## Notes

- The script uses `EXTRACTION_MODEL` from `.env` (default: claude-sonnet-4-6)
- Processing time: ~2-5 min depending on PDF size
- The script saves the extraction to the database automatically
- Filter out "Warning: Ran out of space in font private use area" messages (PDF font warnings)
