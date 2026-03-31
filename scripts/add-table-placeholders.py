#!/usr/bin/env python3
"""
Inject FELD_* placeholders into empty table cells in Gutachten DOCX templates.
Maps table row labels to the corresponding FELD_* placeholder names.
"""
import zipfile
import re
import shutil
import sys
import os

# Mapping: left-cell label pattern → FELD_* placeholder for right cell
TABLE_MAPPINGS = {
    # Table 0: Statistische Angaben (nat + jur)
    r'^Name$': 'FELD_Schuldner_Name',
    r'^Handelsfirma': 'FELD_Schuldner_Firma',
    r'^Anschrift$': 'FELD_Schuldner_Adr',
    r'^Handelsregister$': 'FELD_Schuldner_HRB',
    r'^Insolvenzforderungen': 'FELD_Forderungen_Gesamt',
    r'^Antragsteller': 'FELD_Antragsteller_Name',
    r'^Antragsgrund': 'FELD_Verfahren_Eroeffnungsgrund',
    r'^Unternehmensgegenstand': 'FELD_Schuldner_Firma',
    r'^Arbeitnehmer$': 'FELD_Arbeitnehmer_Anzahl',

    # Table 1 (nat) / Table 2 (jur): Steuerrechtliche Angaben
    r'^Finanzamt$': 'FELD_Finanzamt',
    r'^Steuer-Nr': 'FELD_Steuernummer',
    r'^Letzter Jahresabschluss': 'FELD_Letzter_Jahresabschluss',

    # Table 2 (nat): Sonstige Angaben
    r'^Geburtsdatum': 'FELD_Schuldner_Geburtsdaten',
    r'^Ausbildung$': 'FELD_Ausbildung',
    r'^Telefon$': 'FELD_Schuldner_Telefon',
    r'^Mobiltelefon$': 'FELD_Schuldner_Mobiltelefon',
    r'^E-Mail$': 'FELD_Schuldner_Email',
    r'^Sozialversicherungstr': 'FELD_SVTraeger',
    r'^Betriebsnummer$': 'FELD_Betriebsnummer',
    r'^Steuerberater$': 'FELD_Steuerberater',
    r'^Bankverbindungen$': 'FELD_Bankverbindungen',
    r'^Insolvenzsonderkonto$': 'FELD_Anderkonto',
    r'^Zuständiger': 'FELD_Gerichtsvollzieher',
    r'^älteste Forderung': 'FELD_Aelteste_Forderung',

    # Table 1 (jur): Gesellschaftsrechtliche Angaben
    r'^Gesellschafter': 'FELD_Gesellschafter',
    r'^Größenklasse': 'FELD_Groessenklasse',
    r'^Gründung$': 'FELD_Gruendung',
    r'^Eintragung ins Handelsregister': 'FELD_HR_Eintragung',
}


def get_cell_text(cell_xml):
    """Extract plain text from a w:tc element."""
    texts = re.findall(r'<w:t[^>]*>([^<]+)</w:t>', cell_xml)
    return ''.join(texts).strip()


def inject_text_into_cell(cell_xml, placeholder):
    """Replace an empty cell's content with a placeholder text, preserving formatting."""
    # Find the last paragraph in the cell
    paragraphs = list(re.finditer(r'<w:p\b[^>]*>.*?</w:p>', cell_xml, re.DOTALL))
    if not paragraphs:
        return cell_xml

    last_p = paragraphs[-1]
    last_p_xml = last_p.group(0)

    # Check if paragraph has any runs with text
    existing_text = get_cell_text(last_p_xml)
    if existing_text:
        # Cell already has text, don't overwrite
        return cell_xml

    # Find existing run properties to preserve font/size
    rpr_match = re.search(r'<w:rPr>(.*?)</w:rPr>', last_p_xml, re.DOTALL)
    rpr = rpr_match.group(0) if rpr_match else '<w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'

    # Extract paragraph properties
    ppr_match = re.search(r'<w:pPr>.*?</w:pPr>', last_p_xml, re.DOTALL)
    ppr = ppr_match.group(0) if ppr_match else ''

    # Build new paragraph with placeholder
    new_p = f'<w:p>{ppr}<w:r>{rpr}<w:t xml:space="preserve">{placeholder}</w:t></w:r></w:p>'

    # Replace the last paragraph
    cell_xml = cell_xml[:last_p.start()] + new_p + cell_xml[last_p.end():]
    return cell_xml


def process_template(filepath):
    """Process a single DOCX template."""
    print(f"\nProcessing: {filepath}")

    # Read the zip
    z = zipfile.ZipFile(filepath, 'r')
    xml = z.read("word/document.xml").decode("utf-8")
    other_files = {}
    for name in z.namelist():
        if name != "word/document.xml":
            other_files[name] = z.read(name)
    z.close()

    changes = 0

    # Process each table
    def process_table(table_match):
        nonlocal changes
        table_xml = table_match.group(0)

        # Process each row
        def process_row(row_match):
            nonlocal changes
            row_xml = row_match.group(0)
            cells = list(re.finditer(r'<w:tc\b.*?</w:tc>', row_xml, re.DOTALL))

            if len(cells) < 2:
                return row_xml

            # Get label from first cell
            label = get_cell_text(cells[0].group(0))
            if not label:
                return row_xml

            # Check if right cell is empty
            right_cell = cells[-1].group(0)  # Use last cell (rightmost)
            right_text = get_cell_text(right_cell)

            # Match label against our mappings
            for pattern, placeholder in TABLE_MAPPINGS.items():
                if re.match(pattern, label, re.IGNORECASE):
                    if not right_text or right_text in ('(empty)', ''):
                        # Inject placeholder
                        new_right = inject_text_into_cell(right_cell, placeholder)
                        if new_right != right_cell:
                            row_xml = row_xml.replace(right_cell, new_right, 1)
                            changes += 1
                            print(f"  + {label} → {placeholder}")
                    else:
                        print(f"  ~ {label} already has: {right_text[:40]}")
                    break

            return row_xml

        table_xml = re.sub(r'<w:tr\b.*?</w:tr>', process_row, table_xml, flags=re.DOTALL)
        return table_xml

    xml = re.sub(r'<w:tbl\b.*?</w:tbl>', process_table, xml, flags=re.DOTALL)

    # Write back
    backup = filepath + '.bak'
    if not os.path.exists(backup):
        shutil.copy2(filepath, backup)
        print(f"  Backup: {backup}")

    with zipfile.ZipFile(filepath, 'w', zipfile.ZIP_DEFLATED) as zout:
        zout.writestr("word/document.xml", xml)
        for name, data in other_files.items():
            zout.writestr(name, data)

    print(f"  {changes} placeholders injected")
    return changes


if __name__ == '__main__':
    templates = [
        "gutachtenvorlagen/Gutachten Muster natürliche Person.docx",
        "gutachtenvorlagen/Gutachten Muster juristische Person.docx",
    ]

    # Check if there's a Personengesellschaft template too
    pg = "gutachtenvorlagen/Gutachten Muster Personengesellschaft.docx"
    if os.path.exists(pg):
        templates.append(pg)

    total = 0
    for t in templates:
        if os.path.exists(t):
            total += process_template(t)
        else:
            print(f"  Not found: {t}")

    print(f"\nTotal: {total} placeholders injected across all templates")
