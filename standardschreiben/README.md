# Standardanschreiben – Checklisten & Vorlagen

Dieser Ordner enthält die Muster-PDFs für die Standardanschreiben. **Jedes Dokument ist ein eigener Typ** – die Checkliste wird aus den vorhandenen PDFs abgeleitet.

## Zuordnung: PDF-Vorlage ↔ Anschreiben-Typ (10 Typen)

| Anschreiben-Typ | Template-PDF |
|-----------------|--------------|
| Bankenauskunft | `Bankenanfrage.pdf` |
| Bausparkassen-Anfrage | `Anfrage_zu_bestehendem_Vertragsverhältnis_Bausparkasse_.pdf` |
| Steuerberater-Kontakt | `Muster_Kontaktaufnahme_Steuerberater.pdf` |
| Strafakte-Akteneinsicht | `Einsichtnahmegesuch_Strafakte_Anfrage_zur_Akteneinsicht_.pdf` |
| KFZ-Halteranfrage Zulassungsstelle | `Halteranfrage_Zulassungsstelle.pdf` |
| Gewerbeauskunft | `Gewerbeanfrage.pdf` |
| Finanzamt-Anfrage | `Anfrage_ans_Finanzamt.pdf` |
| KFZ-Halteranfrage KBA | `Halteranfrage_Kraftfahrt_Bundesamt.pdf` |
| Versicherungsanfrage | `Muster_Versicherungsanfrage.pdf` |
| Gerichtsvollzieher-Anfrage | `Gerichtsvollzieheranfrage.pdf` |

## Checklisten (`checklisten.json`)

Die Datei `checklisten.json` definiert pro Anschreiben-Typ:

- **requiredFields**: Pfade zu den Pflichtfeldern im ExtractionResult (z.B. `schuldner.name`, `verfahrensdaten.aktenzeichen`)
- **empfaengerDefault**: Generischer Empfänger, wenn keine konkrete Institution bekannt ist
- **templatePdf**: Zugeordnete Muster-PDF (oder `null`)
- **fehlendeDatenBeispiele**: Typische Angaben für `fehlende_daten`, wenn Status „fehlt“

### Feldpfad-Konvention

Pfade verweisen auf das ExtractionResult-Objekt. Der tatsächliche Wert steht jeweils unter `.wert`:

- `verfahrensdaten.aktenzeichen` → `result.verfahrensdaten.aktenzeichen.wert`
- `schuldner.name` → `result.schuldner.name.wert`

### OR-Gruppen (`requiredFieldsOr`)

Manche Anschreiben benötigen entweder Daten einer natürlichen Person ODER einer Firma:

- **Gruppe 1** (natürliche Person): `schuldner.name`, `schuldner.vorname`, `schuldner.aktuelle_adresse`
- **Gruppe 2** (Firma): `schuldner.firma`, `schuldner.betriebsstaette_adresse`

Es muss **mindestens eine Gruppe vollständig** erfüllt sein (alle Felder der Gruppe haben einen Wert).

### Verwendung

Ein Anschreiben gilt als „bereit“, wenn:

1. Alle `requiredFields` einen nicht-leeren Wert haben
2. Mindestens eine `requiredFieldsOr`-Gruppe vollständig erfüllt ist (falls vorhanden)

Die Checklisten werden **automatisch** nach jeder Extraktion angewendet (`backend/src/utils/letterChecklist.ts`): Die KI-Einschätzung von „bereit“/„fehlt“ wird gegen die Checklisten geprüft und ggf. korrigiert.
