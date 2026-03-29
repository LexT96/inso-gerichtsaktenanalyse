---
name: suggest-domain-review
enabled: true
event: file
conditions:
  - field: file_path
    operator: regex_match
    pattern: anthropic\.ts$
  - field: new_text
    operator: regex_match
    pattern: §\s*\d+|InsO|ZPO|InsVV|Anfechtung|Pfändung|Zahlungsunfähigkeit|Überschuldung
---

**Insolvenzrechtliche Prompt-Änderung erkannt!**

Sie haben den Extraktions-Prompt geändert und dabei rechtliche Begriffe/Paragraphen modifiziert.

**Empfehlung:** Dispatchen Sie den `insolvency-domain-reviewer` Agenten um die rechtliche Korrektheit zu prüfen:

```
Dispatch agent: insolvency-domain-reviewer
Prompt: "Review the EXTRACTION_PROMPT in backend/src/services/anthropic.ts for legal accuracy"
```

Bekannte Fehlerquellen:
- § 131 InsO hat 3 Monate Rückrechnungsfrist (nicht 1 Monat)
- § 850c ZPO Pfändungstabelle ist eine Stufenfunktion (nicht "70% vereinfacht")
- "nicht bekannt" → null (nicht false)
