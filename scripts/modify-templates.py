#!/usr/bin/env python3
"""
Modify Gutachten DOCX templates:
1. Rename FELD_* → KI_* placeholders
2. Inject KI_* placeholders into empty table cells
3. Replace generic [...] with descriptive placeholders

Uses proper XML parsing (ElementTree) to avoid breaking DOCX structure.
"""
import zipfile
import os
import re
from xml.etree import ElementTree as ET

# Word XML namespace
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
ET.register_namespace('w', NS['w'])

# Register ALL namespaces from the document to preserve them
KNOWN_NS = {
    'wpc': 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas',
    'cx': 'http://schemas.microsoft.com/office/drawing/2014/chartex',
    'mc': 'http://schemas.openxmlformats.org/markup-compatibility/2006',
    'o': 'urn:schemas-microsoft-com:office:office',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'm': 'http://schemas.openxmlformats.org/officeDocument/2006/math',
    'v': 'urn:schemas-microsoft-com:vml',
    'wp14': 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing',
    'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    'w10': 'urn:schemas-microsoft-com:office:word',
    'w14': 'http://schemas.microsoft.com/office/word/2010/wordml',
    'w15': 'http://schemas.microsoft.com/office/word/2012/wordml',
    'w16cex': 'http://schemas.microsoft.com/office/word/2018/wordml/cex',
    'w16cid': 'http://schemas.microsoft.com/office/word/2016/wordml/cid',
    'w16': 'http://schemas.microsoft.com/office/word/2018/wordml',
    'w16sdtdh': 'http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash',
    'w16se': 'http://schemas.microsoft.com/office/word/2015/wordml/symex',
    'wpg': 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
    'wpi': 'http://schemas.microsoft.com/office/word/2010/wordprocessingInk',
    'wne': 'http://schemas.microsoft.com/office/word/2006/wordml',
    'wps': 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
    'aink': 'http://schemas.microsoft.com/office/drawing/2016/ink',
    'am3d': 'http://schemas.microsoft.com/office/drawing/2017/model3d',
}

for prefix, uri in KNOWN_NS.items():
    ET.register_namespace(prefix, uri)


def get_paragraph_text(p_elem):
    """Get full text content of a w:p element."""
    texts = []
    for t in p_elem.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'):
        if t.text:
            texts.append(t.text)
    return ''.join(texts)


def set_cell_text(tc_elem, text):
    """Set text in a table cell, preserving structure. Only if cell is empty."""
    W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

    # Check if cell already has text
    existing = get_paragraph_text(tc_elem)
    if existing.strip():
        return False

    # Find last paragraph in cell
    paragraphs = tc_elem.findall(f'{{{W}}}p')
    if not paragraphs:
        return False

    last_p = paragraphs[-1]

    # Create a new run with the text
    r = ET.SubElement(last_p, f'{{{W}}}r')
    rpr = ET.SubElement(r, f'{{{W}}}rPr')
    sz = ET.SubElement(rpr, f'{{{W}}}sz')
    sz.set(f'{{{W}}}val', '18')
    szCs = ET.SubElement(rpr, f'{{{W}}}szCs')
    szCs.set(f'{{{W}}}val', '18')
    t = ET.SubElement(r, f'{{{W}}}t')
    t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    t.text = text

    return True


def replace_text_in_element(elem, old, new):
    """Replace text in all w:t elements within an element."""
    W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    changed = False
    for t in elem.iter(f'{{{W}}}t'):
        if t.text and old in t.text:
            t.text = t.text.replace(old, new)
            changed = True
    return changed


# Table cell mappings: left-cell label → placeholder for right cell
TABLE_MAPPINGS = {
    r'^Name$': 'KI_Schuldner_Name',
    r'^Handelsfirma': 'KI_Schuldner_Firma',
    r'^Anschrift$': 'KI_Schuldner_Adr',
    r'^Handelsregister$': 'KI_Schuldner_HRB',
    r'^Insolvenzforderungen': 'KI_Forderungen_Gesamt',
    r'^Antragsteller': 'KI_Antragsteller_Name',
    r'^Antragsgrund': 'KI_Verfahren_Eroeffnungsgrund',
    r'^Unternehmensgegenstand': 'KI_Schuldner_Firma',
    r'^Arbeitnehmer$': 'KI_Arbeitnehmer_Anzahl',
    r'^Finanzamt$': 'KI_Finanzamt',
    r'^Steuer-Nr': 'KI_Steuernummer',
    r'^Letzter Jahresabschluss': 'KI_Letzter_Jahresabschluss',
    r'^Geburtsdatum': 'KI_Schuldner_Geburtsdaten',
    r'^Ausbildung$': 'KI_Ausbildung',
    r'^Telefon$': 'KI_Schuldner_Telefon',
    r'^Mobiltelefon$': 'KI_Schuldner_Mobiltelefon',
    r'^E-Mail$': 'KI_Schuldner_Email',
    r'^Sozialversicherungstr': 'KI_SVTraeger',
    r'^Betriebsnummer$': 'KI_Betriebsnummer',
    r'^Steuerberater$': 'KI_Steuerberater',
    r'^Bankverbindungen$': 'KI_Bankverbindungen',
    r'^Insolvenzsonderkonto$': 'KI_Anderkonto',
    r'Zuständiger': 'KI_Gerichtsvollzieher',
    r'^älteste Forderung': 'KI_Aelteste_Forderung',
    r'^Gesellschafter': 'KI_Gesellschafter',
    r'^Größenklasse': 'KI_Groessenklasse',
    r'^Gründung$': 'KI_Gruendung',
    r'^Eintragung ins Handelsregister': 'KI_HR_Eintragung',
}

# Text replacements: (old_text, new_text) applied to w:t content
TEXT_REPLACEMENTS = [
    # FELD_ → KI_ rename
    ('FELD_', 'KI_'),

    # Descriptive slot replacements (inline)
    ('beschäftigt […] Arbeitnehmer', 'beschäftigt [Anzahl Arbeitnehmer] Arbeitnehmer'),
    ('beschäftigt [\u2026] Arbeitnehmer', 'beschäftigt [Anzahl Arbeitnehmer] Arbeitnehmer'),
    ('davon […] im Ausbildungsverhältnis', 'davon [Anzahl Auszubildende] im Ausbildungsverhältnis'),
    ('davon [\u2026] im Ausbildungsverhältnis', 'davon [Anzahl Auszubildende] im Ausbildungsverhältnis'),
    ('Lohnrückstände sind […] aufgelaufen', 'Lohnrückstände sind [Betrag/Status Lohnrückstände] aufgelaufen'),
    ('Lohnrückstände sind [\u2026] aufgelaufen', 'Lohnrückstände sind [Betrag/Status Lohnrückstände] aufgelaufen'),
    ('Nettolohnzahlungen für […] im Rahmen', 'Nettolohnzahlungen für [Monate Insolvenzgeldvorfinanzierung] im Rahmen'),
    ('Nettolohnzahlungen für [\u2026] im Rahmen', 'Nettolohnzahlungen für [Monate Insolvenzgeldvorfinanzierung] im Rahmen'),
    ('Betriebsversammlung am […] wurden', 'Betriebsversammlung am [Datum Betriebsversammlung] wurden'),
    ('Betriebsversammlung am [\u2026] wurden', 'Betriebsversammlung am [Datum Betriebsversammlung] wurden'),
    ('– zum […] –', '– zum [empfohlenes Eröffnungsdatum] –'),
    ('– zum [\u2026] –', '– zum [empfohlenes Eröffnungsdatum] –'),
    ('Kosten in Höhe von […] EUR', 'Kosten in Höhe von [Betrag Insolvenzgeldvorfinanzierung] EUR'),
    ('Kosten in Höhe von [\u2026] EUR', 'Kosten in Höhe von [Betrag Insolvenzgeldvorfinanzierung] EUR'),
    ('am xxxx in Auftrag', 'am [Datum Inventarauftrag] in Auftrag'),
    ('zwischen dem xxxx und xxxx', 'zwischen dem [Startdatum Inventar] und [Enddatum Inventar]'),
    ('Sachverständigen xxxxxx.', 'Sachverständigen [Name Sachverständiger Inventar].'),
    ('Gutachten vom xxxxx.', 'Gutachten vom [Datum Inventargutachten].'),
]

# Section-based standalone slot naming
SECTION_SLOT_MAP = {
    'Gewerberaummietverträge': '[Gewerberaummiet-/Pachtverträge Beschreibung]',
    'Versicherungsverträge': '[Versicherungsverträge Beschreibung]',
    'Versorgungsverträge': '[Versorgungsverträge Beschreibung]',
    'Sonstige Verträge': '[sonstige Vertragsverhältnisse]',
    'Factoring': '[Factoring-Vereinbarungen]',
    'Anhängige Rechtsstreitigkeiten': '[anhängige Rechtsstreitigkeiten]',
    'Drittsicherheiten': '[Drittsicherheiten Beschreibung]',
    'Vorliegen im Gutachtenfall': '[Vorliegen Zahlungsunfähigkeit im konkreten Fall]',
    'Ansprüche aus Insolvenzanfechtung': '[Anfechtungsansprüche §§ 129 ff. InsO]',
    'Kostenbeiträge': '[Kostenbeiträge gem. § 171 InsO]',
    'Ergebnis und Empfehlung': '[Ergebnis und Empfehlung des Gutachters]',
    'selbst geschaffene gewerbliche': '[selbst geschaffene Schutzrechte Beschreibung/Wert]',
    'entgeltlich erworbene Konzessionen': '[entgeltlich erworbene Rechte Beschreibung/Wert]',
    'Grundstücke und grundstücksgleiche': '[Grundstücke Beschreibung/Wert]',
    'technische Anlagen und Maschinen': '[technische Anlagen Beschreibung/Wert]',
    'Betriebs- und Geschäftsausstattung': '[BGA Beschreibung/Wert]',
    'Anteile an verbundenen Unternehmen': '[Anteile verbundene Unternehmen Beschreibung/Wert]',
    'Beteiligungen': '[Beteiligungen Beschreibung/Wert]',
    'Wertpapiere des Anlagevermögens': '[Wertpapiere Anlagevermögen Beschreibung/Wert]',
    'Roh-, Hilfs- und Betriebsstoffe': '[RHB-Stoffe Beschreibung/Wert]',
    'unfertige Erzeugnisse': '[unfertige Erzeugnisse Beschreibung/Wert]',
    'fertige Erzeugnisse': '[fertige Erzeugnisse/Waren Beschreibung/Wert]',
    'Forderungen gegen Unternehmen, mit denen': '[Forderungen Beteiligungsunternehmen]',
    'sonstige Vermögensgegenstände': '[sonstige Vermögensgegenstände Beschreibung/Wert]',
}


def process_template(filepath):
    print(f"\n=== {os.path.basename(filepath)} ===")

    z = zipfile.ZipFile(filepath, 'r')

    # Read all files
    file_contents = {}
    for name in z.namelist():
        file_contents[name] = z.read(name)
    z.close()

    # Parse document.xml
    doc_xml_bytes = file_contents['word/document.xml']

    # ElementTree needs the raw XML string for namespace handling
    doc_xml_str = doc_xml_bytes.decode('utf-8')

    # Step 1: Simple text replacements (FELD_→KI_, descriptive slots)
    changes = 0
    for old, new in TEXT_REPLACEMENTS:
        count = doc_xml_str.count(old)
        if count > 0:
            doc_xml_str = doc_xml_str.replace(old, new)
            changes += count
    print(f"  Text replacements: {changes}")

    # Step 2: Parse XML for structural modifications
    root = ET.fromstring(doc_xml_str)
    W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

    # Step 3: Table cell placeholders
    table_changes = 0
    for tbl in root.iter(f'{{{W}}}tbl'):
        for tr in tbl.findall(f'{{{W}}}tr'):
            cells = tr.findall(f'{{{W}}}tc')
            if len(cells) < 2:
                continue

            label = get_paragraph_text(cells[0]).strip()
            if not label:
                continue

            for pattern, placeholder in TABLE_MAPPINGS.items():
                if re.match(pattern, label, re.IGNORECASE):
                    right_cell = cells[-1]
                    if set_cell_text(right_cell, placeholder):
                        table_changes += 1
                    break

    print(f"  Table cell placeholders: {table_changes}")

    # Step 4: Section-aware standalone slot renaming
    # Track preceding headings and rename standalone [...]/[…]
    section_changes = 0
    prev_heading = ''
    finding_num = 0

    for body in root.iter(f'{{{W}}}body'):
        for elem in body:
            if elem.tag != f'{{{W}}}p':
                # For tables and other elements, still track headings
                text = get_paragraph_text(elem)
                if text.strip():
                    prev_heading = text.strip()
                continue

            text = get_paragraph_text(elem).strip()

            # Track headings
            if text and text not in ('[…]', '[...]', '[…].') and not text.startswith('['):
                prev_heading = text

            # Handle standalone [...] / […]
            if text in ('[…]', '[...]', '[…].'):
                replacement = None

                # Check numbered findings
                if 'welches zu dem Ergebnis kommt' in prev_heading:
                    finding_num += 1
                    replacement = f'[Ergebnis {finding_num}: Kernaussage Gutachten]'

                # Check section map
                if not replacement:
                    for section_key, repl in SECTION_SLOT_MAP.items():
                        if section_key in prev_heading:
                            replacement = repl
                            break

                # Check Anlage
                if not replacement:
                    anlage_match = re.match(r'Anlage\s+([IVX]+)', prev_heading)
                    if anlage_match:
                        replacement = f'[Bezeichnung Anlage {anlage_match.group(1)}]'

                if replacement:
                    for t in elem.iter(f'{{{W}}}t'):
                        if t.text and ('…' in t.text or '...' in t.text):
                            suffix = '.' if text.endswith('.') else ''
                            t.text = replacement + suffix
                            section_changes += 1
                            break

    print(f"  Section-aware slots: {section_changes}")

    # Step 5: Serialize back
    doc_xml_out = ET.tostring(root, encoding='unicode', xml_declaration=False)
    # Add XML declaration
    doc_xml_out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + doc_xml_out

    # Verify well-formedness
    try:
        ET.fromstring(doc_xml_out)
        print("  XML validation: OK")
    except ET.ParseError as e:
        print(f"  XML validation FAILED: {e}")
        return 0

    # Write back
    file_contents['word/document.xml'] = doc_xml_out.encode('utf-8')

    with zipfile.ZipFile(filepath, 'w', zipfile.ZIP_DEFLATED) as zout:
        for name, data in file_contents.items():
            zout.writestr(name, data)

    total = changes + table_changes + section_changes
    print(f"  Total changes: {total}")
    return total


if __name__ == '__main__':
    templates = [
        "gutachtenvorlagen/Gutachten Muster natürliche Person.docx",
        "gutachtenvorlagen/Gutachten Muster juristische Person.docx",
        "gutachtenvorlagen/Gutachten Muster Personengesellschaft.docx",
    ]

    grand_total = 0
    for t in templates:
        if os.path.exists(t):
            grand_total += process_template(t)

    print(f"\nGrand total: {grand_total} changes")
