#!/usr/bin/env python3
"""
Rename all FELD_* placeholders to KI_* inside Gutachten DOCX templates.

DOCX files are ZIP archives containing XML. This script opens each template,
reads every XML part (document, headers, footers), replaces all occurrences
of 'FELD_' with 'KI_', and writes the modified ZIP back.

Creates .bak backup files before modifying.
"""
import zipfile
import shutil
import os
import sys

# All XML parts that may contain placeholders
XML_PARTS = [
    "word/document.xml",
    "word/header1.xml", "word/header2.xml", "word/header3.xml",
    "word/footer1.xml", "word/footer2.xml", "word/footer3.xml",
]

TEMPLATES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "gutachtenvorlagen")

TEMPLATES = [
    "Gutachten Muster nat\u00fcrliche Person.docx",
    "Gutachten Muster juristische Person.docx",
    "Gutachten Muster Personengesellschaft.docx",
]


def process_template(filepath):
    """Replace all FELD_ occurrences with KI_ in a DOCX template."""
    print(f"\nProcessing: {filepath}")

    if not os.path.exists(filepath):
        print(f"  SKIP: file not found")
        return 0

    # Create backup
    backup = filepath + ".bak"
    if not os.path.exists(backup):
        shutil.copy2(filepath, backup)
        print(f"  Backup: {backup}")
    else:
        print(f"  Backup already exists: {backup}")

    # Read entire ZIP into memory
    z = zipfile.ZipFile(filepath, "r")
    all_files = {}
    for name in z.namelist():
        all_files[name] = z.read(name)
    z.close()

    total_replacements = 0

    # Process each XML part
    for part_name in XML_PARTS:
        if part_name not in all_files:
            continue

        xml_bytes = all_files[part_name]
        xml_text = xml_bytes.decode("utf-8")

        count = xml_text.count("FELD_")
        if count == 0:
            continue

        xml_text = xml_text.replace("FELD_", "KI_")
        all_files[part_name] = xml_text.encode("utf-8")
        total_replacements += count
        print(f"  {part_name}: {count} replacements")

    if total_replacements == 0:
        print("  No FELD_ placeholders found")
        return 0

    # Write back the modified ZIP
    with zipfile.ZipFile(filepath, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in all_files.items():
            zout.writestr(name, data)

    print(f"  Total: {total_replacements} FELD_ -> KI_ replacements")
    return total_replacements


if __name__ == "__main__":
    grand_total = 0
    for template_name in TEMPLATES:
        filepath = os.path.join(TEMPLATES_DIR, template_name)
        grand_total += process_template(filepath)

    print(f"\n{'='*60}")
    print(f"Grand total: {grand_total} replacements across all templates")
    if grand_total > 0:
        print("Done. Backup files (.bak) created for each modified template.")
    else:
        print("No replacements needed (already renamed or no FELD_ found).")
