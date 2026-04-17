# Briefkopf for Gutachten Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add TBS firm letterhead (Briefkopf) to Gutachten templates — logo, colored bars, right-side info block (Sachbearbeiter/Durchwahl/Email/Zeichen), partner sidebar, and footer with red line + page numbers.

**Architecture:** Briefkopf layout is baked directly into the 3 Gutachten DOCX templates (no runtime merging). Dynamic fields use `KI_*` placeholders filled at generation time. Partner sidebar is static in templates, updated via an authoring-time sync script reading from `kanzlei.json`. Sachbearbeiter auto-fills from verwalter profile but can be overridden per extraction.

**Tech Stack:** python-docx (template sync script), PizZip/XML (existing Gutachten generator), SQLite (migration), React (wizard UI)

---

### Task 1: Create kanzlei.json

**Files:**
- Create: `gutachtenvorlagen/kanzlei.json`

- [ ] **Step 1: Create kanzlei.json with firm data**

```json
{
  "kanzlei": {
    "name": "Prof. Dr. Dr. Thomas B. Schmidt Insolvenzverwalter Rechtsanwälte Partnerschaft mbB",
    "kurz": "TBS Insolvenzverwalter",
    "website": "www.tbs-insolvenzverwalter.de",
    "partnerschaftsregister": "Amtsgericht Koblenz – PR 20203"
  },
  "standorte": {
    "Trier": { "adresse": "Balduinstraße 22-24, 54290 Trier", "telefon": "0651 / 170 830 - 0" },
    "Zell/Mosel": { "adresse": "Schlossstraße 7, 56856 Zell", "telefon": "06542 / 9699 - 0" },
    "Wiesbaden": { "adresse": "Luisenstraße 7, 65185 Wiesbaden", "telefon": "0611 / 950 157 - 0" },
    "Koblenz": { "adresse": "Löhrstraße 99, 56068 Koblenz", "telefon": "0261 / 134 69 - 0" },
    "Bad Kreuznach": { "adresse": "Kurhausstraße 15, 55543 Bad Kreuznach", "telefon": "0671 / 920 148 - 0" },
    "Frankfurt am Main": { "adresse": "", "telefon": "" },
    "Idar-Oberstein": { "adresse": "", "telefon": "" },
    "Langgöns": { "adresse": "", "telefon": "" },
    "Limburg/Lahn": { "adresse": "", "telefon": "" },
    "Mainz": { "adresse": "", "telefon": "" }
  },
  "partner": [
    { "name": "Ingo Grünewald", "titel": "Fachanwalt für Insolvenz- und Sanierungsrecht\nFachanwalt für Handels- und Gesellschaftsrecht", "kategorie": "PARTNER" },
    { "name": "Dr. Alexander Thomas Lamberty LL.M.", "titel": "Fachanwalt für Insolvenz- und Sanierungsrecht", "kategorie": "PARTNER" },
    { "name": "Fatma Kreft", "titel": "Fachanwältin für Insolvenz- und Sanierungsrecht\nFachanwältin für Steuerrecht", "kategorie": "PARTNER" },
    { "name": "Dr. Arne Löser", "titel": "Fachanwalt für Insolvenz- und Sanierungsrecht\nFachanwalt für Handels- und Gesellschaftsrecht", "kategorie": "PARTNER" },
    { "name": "Dr. Thomas Thöne", "titel": "Fachanwalt für Insolvenz- und Sanierungsrecht\nFachanwalt für Steuerrecht\nNotar in Wiesbaden", "kategorie": "PARTNER" },
    { "name": "Eva Meyer", "titel": "Fachanwältin für Insolvenz- und Sanierungsrecht", "kategorie": "ANGESTELLTE RECHTSANWÄLTE" },
    { "name": "Bettina Dax", "titel": "Rechtsanwältin", "kategorie": "ANGESTELLTE RECHTSANWÄLTE" },
    { "name": "Cornelia Kriege", "titel": "Rechtsanwältin", "kategorie": "ANGESTELLTE RECHTSANWÄLTE" },
    { "name": "Lars Wacker", "titel": "Rechtsanwalt", "kategorie": "ANGESTELLTE RECHTSANWÄLTE" },
    { "name": "Justizrat Prof. Dr. Dr. Thomas B. Schmidt M.A.", "titel": "Fachanwalt für Insolvenz- und Sanierungsrecht", "kategorie": "OF COUNSEL" }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add gutachtenvorlagen/kanzlei.json
git commit -m "feat: add kanzlei.json with firm data for Briefkopf"
```

---

### Task 2: Add new Briefkopf KI_* placeholders to gutachten-mapping.json

**Files:**
- Modify: `gutachtenvorlagen/gutachten-mapping.json`

The Briefkopf right-side info block needs these new placeholders. They will be placed in the DOCX templates (Task 4) and filled at generation time.

- [ ] **Step 1: Add new Sachbearbeiter/Briefkopf field mappings**

Add these entries to the `felder` object in `gutachten-mapping.json`:

```json
"KI_Sachbearbeiter_Name": { "input": "sachbearbeiter_name" },
"KI_Sachbearbeiter_Durchwahl": { "input": "sachbearbeiter_durchwahl" },
"KI_Sachbearbeiter_Email": { "input": "sachbearbeiter_email" },
"KI_Standort_Telefon": { "input": "verwalter_standort_telefon" },
"KI_Mein_Zeichen": { "computed": "mein_zeichen" },
"KI_Ihr_Zeichen": { "computed": "ihr_zeichen" },
"KI_Briefkopf_Datum": { "computed": "briefkopf_datum" },
"KI_Briefkopf_Ort": { "computed": "briefkopf_ort" }
```

- [ ] **Step 2: Commit**

```bash
git add gutachtenvorlagen/gutachten-mapping.json
git commit -m "feat: add Briefkopf KI_* field mappings for Sachbearbeiter info block"
```

---

### Task 3: Implement computed fields for new Briefkopf placeholders

**Files:**
- Modify: `backend/src/utils/gutachtenGenerator.ts:235` (inside `computeGutachtenField` switch)
- Modify: `backend/src/utils/gutachtenGenerator.ts:20` (GutachtenUserInputs interface)

- [ ] **Step 1: Add new fields to GutachtenUserInputs interface**

In `backend/src/utils/gutachtenGenerator.ts`, add to the `GutachtenUserInputs` interface (around line 20):

```typescript
  verwalter_standort_telefon?: string;
```

- [ ] **Step 2: Add computed field cases to computeGutachtenField switch**

Add these cases to the switch statement in `computeGutachtenField` (after the existing Verwalter cases, around line 460):

```typescript
    // --- Briefkopf ---
    case 'mein_zeichen': {
      const gericht = getByPath(result, 'verfahrensdaten.gericht.wert');
      const az = getByPath(result, 'verfahrensdaten.aktenzeichen.wert');
      if (gericht && az) return `${gericht}, Az. ${az}`;
      if (az) return az;
      return '';
    }

    case 'ihr_zeichen':
      return getByPath(result, 'verfahrensdaten.aktenzeichen.wert');

    case 'briefkopf_datum': {
      const now = new Date();
      const day = String(now.getDate()).padStart(2, '0');
      const month = String(now.getMonth() + 1).padStart(2, '0');
      return `${day}.${month}.${now.getFullYear()}`;
    }

    case 'briefkopf_ort':
      return inputs.verwalter_standort || 'Trier';
```

- [ ] **Step 3: Pass standort_telefon from kanzlei.json in the route**

In `backend/src/routes/generateGutachten.ts`, update `parseUserInputs` to pass through the new field:

```typescript
    verwalter_standort_telefon: body.verwalter_standort_telefon ? String(body.verwalter_standort_telefon) : undefined,
```

- [ ] **Step 4: Run type-check**

Run: `cd backend && npx tsc --noEmit`
Expected: clean (no errors)

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/gutachtenGenerator.ts backend/src/routes/generateGutachten.ts
git commit -m "feat: implement computed fields for Briefkopf placeholders"
```

---

### Task 4: Add verwalter_id to extractions table

**Files:**
- Create: `backend/src/db/migrations/006_add_verwalter_id.sql`

- [ ] **Step 1: Create migration**

```sql
ALTER TABLE extractions ADD COLUMN verwalter_id INTEGER REFERENCES verwalter_profiles(id);
```

- [ ] **Step 2: Run type-check to confirm migration is picked up**

Run: `cd backend && npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add backend/src/db/migrations/006_add_verwalter_id.sql
git commit -m "feat: add verwalter_id column to extractions table"
```

---

### Task 5: Auto-fill Sachbearbeiter from Verwalter profile in GutachtenWizard

**Files:**
- Modify: `frontend/src/components/extraction/GutachtenWizard.tsx`

The wizard already has Sachbearbeiter fields (step 2) and Verwalter selection (step 1). Currently the Sachbearbeiter fields are empty by default. We need to auto-fill them from the selected Verwalter profile, while still allowing manual override.

- [ ] **Step 1: Auto-fill Sachbearbeiter when Verwalter is selected**

In `GutachtenWizard.tsx`, update the `handleSelectVerwalter` function (around line 74):

```typescript
  const handleSelectVerwalter = (profile: VerwalterProfile) => {
    setSelectedVerwalter(profile);
    if (profile.anderkonto_iban) setAnderkontoIban(profile.anderkonto_iban);
    if (profile.anderkonto_bank) setAnderkontoBank(profile.anderkonto_bank);
    // Auto-fill Sachbearbeiter from profile defaults (user can override in step 2)
    if (profile.sachbearbeiter_name) setSachbearbeiterName(profile.sachbearbeiter_name);
    if (profile.sachbearbeiter_email) setSachbearbeiterEmail(profile.sachbearbeiter_email);
    if (profile.sachbearbeiter_durchwahl) setSachbearbeiterDurchwahl(profile.sachbearbeiter_durchwahl);
  };
```

- [ ] **Step 2: Pass standort_telefon from kanzlei.json via buildUserInputs**

In `buildUserInputs()` (around line 110), add standort telephone lookup:

```typescript
    // Standort telephone from kanzlei config
    const STANDORT_TELEFON: Record<string, string> = {
      'Trier': '0651 / 170 830 - 0',
      'Zell/Mosel': '06542 / 9699 - 0',
      'Wiesbaden': '0611 / 950 157 - 0',
      'Koblenz': '0261 / 134 69 - 0',
      'Bad Kreuznach': '0671 / 920 148 - 0',
    };
    body.verwalter_standort_telefon = STANDORT_TELEFON[selectedVerwalter?.standort || ''] || '0651 / 170 830 - 0';
```

- [ ] **Step 3: Run frontend type-check**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -v PdfViewer`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/extraction/GutachtenWizard.tsx
git commit -m "feat: auto-fill Sachbearbeiter from Verwalter profile + standort telefon"
```

---

### Task 6: Rebuild Gutachten DOCX templates with Briefkopf layout

**Files:**
- Modify: `gutachtenvorlagen/Gutachten Muster natürliche Person.docx`
- Modify: `gutachtenvorlagen/Gutachten Muster juristische Person.docx`
- Modify: `gutachtenvorlagen/Gutachten Muster Personengesellschaft.docx`
- Reference: `/Users/thorsten/Downloads/Briefkopf_TBS.docx`

This is a **manual task in Microsoft Word**. Open each Gutachten template and the Briefkopf reference side by side.

- [ ] **Step 1: Copy visual elements from Briefkopf into each template**

For each of the 3 templates:
1. Open the Briefkopf DOCX in Word
2. Open the Gutachten template in Word
3. Copy from Briefkopf → paste into Gutachten template:
   - Logo image (top-left)
   - Decorative colored bars (EMF shapes)
   - Red footer line image
4. Set margins to match Briefkopf: L≈1.13cm, R≈1.27cm, T≈1.41cm, B≈1.27cm

- [ ] **Step 2: Add right-side info block with KI_* placeholders**

In the body area (right-aligned, matching Briefkopf positioning), add these paragraphs:

```
Sachbearbeiter/in                    [right-aligned, 7pt, regular]
KI_Sachbearbeiter_Name               [right-aligned, 8pt, bold]
Durchwahl                            [right-aligned, 7pt, regular]
KI_Sachbearbeiter_Durchwahl          [right-aligned, 8pt, bold]
Standort                             [right-aligned, 7pt, regular]
KI_Standort_Telefon                  [right-aligned, 8pt, bold]
E-Mail                               [right-aligned, 7pt, regular]
KI_Sachbearbeiter_Email              [right-aligned, 8pt, bold]
Mein Zeichen                         [right-aligned, 7pt, regular]
KI_Mein_Zeichen                      [right-aligned, 8pt, bold]
Ihr Zeichen                          [right-aligned, 7pt, regular]
KI_Ihr_Zeichen                       [right-aligned, 8pt, bold]
```

- [ ] **Step 3: Add firm return-address line**

Small text (6pt) above the recipient/case area:
```
Prof. Dr. Dr. Thomas B. Schmidt Insolvenzverwalter Rechtsanwälte Partnerschaft mbB ∙ Kornmarkt 4 ∙ D-54290 Trier
```

- [ ] **Step 4: Add partner sidebar as static text box**

Create a text box positioned in the left/right margin area (matching Briefkopf layout) with the full partner listing:

```
www.tbs-insolvenzverwalter.de
Partnerschaftsregister des
Amtsgericht Koblenz – PR 20203

PARTNER
Ingo Grünewald
Fachanwalt für Insolvenz- und Sanierungsrecht
[... full listing from kanzlei.json ...]

STANDORTE
Trier         Bad Kreuznach
[... full listing ...]
```

- [ ] **Step 5: Set up footer**

In each template's footer section:
- Add the red line image from the Briefkopf
- Add "Seite X von Y" centered (using Word field codes `{PAGE}` / `{NUMPAGES}`)

- [ ] **Step 6: Update date line**

Replace any existing static date with: `KI_Briefkopf_Ort, den KI_Briefkopf_Datum`

- [ ] **Step 7: Verify all KI_* placeholders are present**

Open each template and search for `KI_` — confirm these new placeholders exist:
- `KI_Sachbearbeiter_Name`
- `KI_Sachbearbeiter_Durchwahl`
- `KI_Sachbearbeiter_Email`
- `KI_Standort_Telefon`
- `KI_Mein_Zeichen`
- `KI_Ihr_Zeichen`
- `KI_Briefkopf_Datum`
- `KI_Briefkopf_Ort`

Plus all existing `KI_*` and `[[SLOT_NNN]]` placeholders still intact.

- [ ] **Step 8: Commit templates**

```bash
git add "gutachtenvorlagen/Gutachten Muster natürliche Person.docx"
git add "gutachtenvorlagen/Gutachten Muster juristische Person.docx"
git add "gutachtenvorlagen/Gutachten Muster Personengesellschaft.docx"
git commit -m "feat: rebuild Gutachten templates with TBS Briefkopf layout"
```

---

### Task 7: Write partner sidebar sync script

**Files:**
- Create: `scripts/update-briefkopf.py`

This script reads `kanzlei.json` and updates the partner sidebar text box in all Gutachten (and later Anschreiben) templates. Run it when personnel changes.

- [ ] **Step 1: Create the sync script**

```python
#!/usr/bin/env python3
"""
Update the partner sidebar in all Gutachten DOCX templates from kanzlei.json.

Usage: python scripts/update-briefkopf.py
"""

import json
import sys
from pathlib import Path
from docx import Document
from lxml import etree

REPO_ROOT = Path(__file__).resolve().parent.parent
KANZLEI_JSON = REPO_ROOT / "gutachtenvorlagen" / "kanzlei.json"
TEMPLATES_DIR = REPO_ROOT / "gutachtenvorlagen"

TEMPLATE_FILES = [
    "Gutachten Muster natürliche Person.docx",
    "Gutachten Muster juristische Person.docx",
    "Gutachten Muster Personengesellschaft.docx",
]

WP_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WPS_NS = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape"


def load_kanzlei():
    with open(KANZLEI_JSON, "r", encoding="utf-8") as f:
        return json.load(f)


def build_sidebar_text(data):
    """Build the partner sidebar text from kanzlei.json data."""
    lines = []
    lines.append(data["kanzlei"]["website"])
    lines.append(f"Partnerschaftsregister des")
    lines.append(data["kanzlei"]["partnerschaftsregister"])
    lines.append("")
    lines.append("")

    # Group partners by category
    categories = {}
    for p in data["partner"]:
        cat = p["kategorie"]
        if cat not in categories:
            categories[cat] = []
        categories[cat].append(p)

    for cat_name in ["PARTNER", "ANGESTELLTE RECHTSANWÄLTE", "OF COUNSEL"]:
        if cat_name not in categories:
            continue
        lines.append("")
        lines.append(cat_name)
        for p in categories[cat_name]:
            lines.append(p["name"])
            for title_line in p["titel"].split("\n"):
                lines.append(title_line)
            lines.append("")

    # Standorte (two columns)
    lines.append("")
    lines.append("STANDORTE")
    standorte = list(data["standorte"].keys())
    for i in range(0, len(standorte), 2):
        left = standorte[i]
        right = standorte[i + 1] if i + 1 < len(standorte) else ""
        lines.append(f"{left}\t\t{right}")

    return "\n".join(lines)


def find_sidebar_textbox(doc):
    """Find the text box containing 'PARTNER' in the document body XML."""
    body = doc.element.body
    # Search in wps:wsp (Word 2010+ drawing shapes) and v:shape (VML)
    for txbx in body.iter(f"{{{WPS_NS}}}txbxContent"):
        full_text = "".join(t.text or "" for t in txbx.iter(f"{{{WP_NS}}}t"))
        if "PARTNER" in full_text:
            return txbx
    return None


def replace_textbox_content(txbx_content, new_text):
    """Replace all paragraphs in a textbox with new_text, preserving first paragraph's formatting."""
    paragraphs = txbx_content.findall(f"{{{WP_NS}}}p")
    if not paragraphs:
        return

    # Save first paragraph's run properties as template
    first_rpr = None
    first_ppr = None
    for p in paragraphs:
        ppr = p.find(f"{{{WP_NS}}}pPr")
        if ppr is not None:
            first_ppr = ppr
        for r in p.findall(f"{{{WP_NS}}}r"):
            rpr = r.find(f"{{{WP_NS}}}rPr")
            if rpr is not None:
                first_rpr = rpr
                break
        if first_rpr is not None:
            break

    # Remove all existing paragraphs
    for p in paragraphs:
        txbx_content.remove(p)

    # Add new paragraphs
    for line in new_text.split("\n"):
        p = etree.SubElement(txbx_content, f"{{{WP_NS}}}p")
        if first_ppr is not None:
            from copy import deepcopy
            p.insert(0, deepcopy(first_ppr))
        r = etree.SubElement(p, f"{{{WP_NS}}}r")
        if first_rpr is not None:
            from copy import deepcopy
            r.insert(0, deepcopy(first_rpr))
        t = etree.SubElement(r, f"{{{WP_NS}}}t")
        t.text = line
        t.set(f"{{{etree.QName('http://www.w3.org/XML/1998/namespace', 'space').namespace}}}space", "preserve")


def main():
    data = load_kanzlei()
    sidebar_text = build_sidebar_text(data)
    print(f"Generated sidebar text ({len(sidebar_text)} chars)")

    updated = 0
    for template_name in TEMPLATE_FILES:
        template_path = TEMPLATES_DIR / template_name
        if not template_path.exists():
            print(f"  SKIP: {template_name} not found")
            continue

        doc = Document(str(template_path))
        txbx = find_sidebar_textbox(doc)
        if txbx is None:
            print(f"  WARN: No partner sidebar text box found in {template_name}")
            continue

        replace_textbox_content(txbx, sidebar_text)
        doc.save(str(template_path))
        print(f"  OK: Updated {template_name}")
        updated += 1

    print(f"\nDone. Updated {updated}/{len(TEMPLATE_FILES)} templates.")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Make executable and test**

Run: `chmod +x scripts/update-briefkopf.py && python3 scripts/update-briefkopf.py`
Expected: Script runs, reports sidebar text generated. May report "No partner sidebar text box found" until templates are rebuilt (Task 6).

- [ ] **Step 3: Commit**

```bash
git add scripts/update-briefkopf.py
git commit -m "feat: add partner sidebar sync script for Gutachten templates"
```

---

### Task 8: Remove hardcoded standort addresses from GutachtenWizard

**Files:**
- Modify: `frontend/src/components/extraction/GutachtenWizard.tsx`

The wizard currently has `STANDORT_ADRESSEN` hardcoded (line 121). Move this to use the same source as kanzlei.json. Since the frontend can't read JSON from the filesystem, we either load it via API or keep a small constant. For now, consolidate both maps (STANDORT_ADRESSEN and STANDORT_TELEFON from Task 5) into a single constant.

- [ ] **Step 1: Consolidate standort data into one constant**

Replace the separate `STANDORT_ADRESSEN` map and `STANDORT_TELEFON` map with a single `STANDORT_DATA`:

```typescript
const STANDORT_DATA: Record<string, { adresse: string; telefon: string }> = {
  'Trier': { adresse: 'Balduinstraße 22-24, 54290 Trier', telefon: '0651 / 170 830 - 0' },
  'Zell/Mosel': { adresse: 'Schlossstraße 7, 56856 Zell', telefon: '06542 / 9699 - 0' },
  'Wiesbaden': { adresse: 'Luisenstraße 7, 65185 Wiesbaden', telefon: '0611 / 950 157 - 0' },
  'Koblenz': { adresse: 'Löhrstraße 99, 56068 Koblenz', telefon: '0261 / 134 69 - 0' },
  'Bad Kreuznach': { adresse: 'Kurhausstraße 15, 55543 Bad Kreuznach', telefon: '0671 / 920 148 - 0' },
};
```

Update `buildUserInputs()` to use it:

```typescript
    const standort = STANDORT_DATA[selectedVerwalter?.standort || ''];
    body.verwalter_adresse = standort?.adresse || 'Schlossstraße 7, 56856 Zell';
    body.verwalter_standort_telefon = standort?.telefon || '0651 / 170 830 - 0';
```

- [ ] **Step 2: Run frontend type-check**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -v PdfViewer`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/extraction/GutachtenWizard.tsx
git commit -m "refactor: consolidate standort data into single constant"
```

---

### Task 9: End-to-end verification

- [ ] **Step 1: Start dev servers**

Run: `cd backend && npm run dev` and `cd frontend && npm run dev`

- [ ] **Step 2: Test Gutachten generation flow**

1. Open an existing extraction in the browser
2. Go to Gutachten tab → click "Gutachten erstellen"
3. Step 1: Select a Verwalter (e.g., RA Ingo Grünewald)
4. Step 2: Verify Sachbearbeiter auto-fills from profile (Stefan Haug, email, durchwahl)
5. Step 3: Verify Schuldner fields present
6. Step 4: Fill any missing fields
7. Step 5: Generate → download DOCX

- [ ] **Step 3: Inspect generated DOCX**

Open the generated DOCX in Word and verify:
- Right-side info block shows correct Sachbearbeiter name, durchwahl, email
- "Mein Zeichen" shows "Amtsgericht [Ort], Az. [AZ]"
- "Ihr Zeichen" shows the Aktenzeichen
- Date line shows current date with correct Ort
- Briefkopf visual elements present (logo, bars, footer — only after Task 6 templates are rebuilt)
- All existing KI_* fields still filled correctly
- All [[SLOT_NNN]] markers filled by AI

- [ ] **Step 4: Test with different Verwalter**

Switch to a different Verwalter (e.g., RAin Fatma Kreft) and verify:
- Gender-specific fields change (der/die Sachverständige)
- Standort changes
- Sachbearbeiter fields update

---

## Execution Notes

- **Task 6 (template rebuild) is manual in Word** — this is the most time-consuming task and should be done by someone with access to Microsoft Word. All other tasks are code changes.
- **Task 7 (sync script) only works after Task 6** — the templates need the partner sidebar text box to exist before the script can find and update it.
- **Tasks 1-5, 7-8 can be implemented in parallel** — they don't depend on the template rebuild.
- **The `kanzlei.json` standort addresses/telefon should be verified with TBS** — some addresses may be incomplete (Frankfurt, Idar-Oberstein, etc.)
