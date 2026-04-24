/**
 * Declarative registry of handwriting target fields for Stage 3c.
 *
 * Single source of truth for: what fields the handwriting pass reads,
 * which are critical (trigger gap-fill when empty), which form-label
 * anchors Claude should scan for, and which edge-cases matter.
 *
 * Both the main multi-field prompt (via buildMainPrompt) and the gap-fill
 * mini-probes (via buildProbePrompt) are generated from this registry.
 * Adding a new field = one entry here, not editing prompts in multiple places.
 */

export interface HandwritingFieldDef {
  /** Key in the parsed Claude JSON response + merge target on result.schuldner[key] */
  key: string;
  /** Dot-path on ExtractionResult (for future candidate emission; unused in Sprint 1) */
  path: string;
  /** 'critical' fields trigger a gap-fill probe when still empty after the main pass */
  criticality: 'critical' | 'standard' | 'optional';
  /** Short human label used in prompts and logs */
  label: string;
  /** Positive anchors — form-field labels Claude should scan for */
  anchors: string[];
  /** Negative anchors — labels that look similar but mean something else */
  negativeAnchors?: string[];
  /** Edge-case hints — e.g. "fill even if checkbox says identical to private address" */
  edgeCases?: string[];
  /** Anlage hints — which form sections typically contain this field (for Sprint 2 router) */
  anlageHints?: string[];
}

export const HANDWRITING_FIELDS: HandwritingFieldDef[] = [
  // ─── Personal data ───
  {
    key: 'name', path: 'schuldner.name', criticality: 'standard',
    label: 'Nachname',
    anchors: ['Name', 'Familienname', 'Nachname'],
  },
  {
    key: 'vorname', path: 'schuldner.vorname', criticality: 'standard',
    label: 'Vorname',
    anchors: ['Vorname'],
  },
  {
    key: 'geburtsdatum', path: 'schuldner.geburtsdatum', criticality: 'standard',
    label: 'Geburtsdatum',
    anchors: ['Geburtsdatum', 'geboren am', 'geb. am'],
  },
  {
    key: 'geburtsort', path: 'schuldner.geburtsort', criticality: 'optional',
    label: 'Geburtsort',
    anchors: ['Geburtsort', 'geboren in'],
  },
  {
    key: 'geburtsland', path: 'schuldner.geburtsland', criticality: 'optional',
    label: 'Geburtsland',
    anchors: ['Geburtsland', 'Land'],
  },
  {
    key: 'staatsangehoerigkeit', path: 'schuldner.staatsangehoerigkeit', criticality: 'optional',
    label: 'Staatsangehörigkeit',
    anchors: ['Staatsangehörigkeit', 'Nationalität'],
  },
  // ─── Contact & address ───
  {
    key: 'telefon', path: 'schuldner.telefon', criticality: 'critical',
    label: 'Telefon',
    anchors: ['Telefon', 'Tel.', 'Telefonnummer', 'Festnetz'],
    negativeAnchors: ['Telefax', 'Fax'],
  },
  {
    key: 'mobiltelefon', path: 'schuldner.mobiltelefon', criticality: 'standard',
    label: 'Mobiltelefon',
    anchors: ['Mobil', 'Handy', 'Mobilfunk', 'Mobilnummer'],
  },
  {
    key: 'email', path: 'schuldner.email', criticality: 'critical',
    label: 'E-Mail-Adresse',
    anchors: ['E-Mail', 'Email', 'E-Mail-Adresse', 'Mail-Adresse'],
  },
  {
    key: 'aktuelle_adresse', path: 'schuldner.aktuelle_adresse', criticality: 'standard',
    label: 'Aktuelle Privatanschrift',
    anchors: ['Privatanschrift', 'Wohnanschrift', 'Anschrift', 'Straße', 'aktuelle Anschrift'],
    edgeCases: ['Straße + Hausnummer + PLZ + Ort zu einem String "Str. Nr., PLZ Ort" zusammensetzen'],
  },
  // ─── Business ───
  {
    key: 'betriebsstaette_adresse', path: 'schuldner.betriebsstaette_adresse', criticality: 'critical',
    label: 'Anschrift der Betriebsstätte / Geschäftstätigkeit',
    anchors: [
      'Anschrift der Firma', 'Anschrift des Geschäftsbetriebs',
      'Betriebsstätte', 'Geschäftssitz', 'Anschrift der selbständigen Tätigkeit',
      'Büro', 'Werkstatt', 'Firmenanschrift',
    ],
    negativeAnchors: ['Privatanschrift allein'],
    edgeCases: [
      'IMMER füllen wenn eine Firmenanschrift sichtbar ist, auch wenn eine Checkbox "befinden sich unter der gleichen Anschrift" oder "identisch mit Privatanschrift" angekreuzt ist — in diesem Fall die sichtbare Adresse (auch Privatanschrift) übernehmen',
      'Straße + Hausnummer + PLZ + Ort als einen String formatieren',
    ],
    anlageHints: ['Anlage 2', 'Angaben zur Firma', 'Ergänzende betriebliche Angaben'],
  },
  {
    key: 'geschaeftszweig', path: 'schuldner.geschaeftszweig', criticality: 'standard',
    label: 'Geschäftszweig / Branche',
    anchors: ['Geschäftszweig', 'Branche', 'Tätigkeit', 'Gewerbe', 'Gegenstand des Unternehmens'],
    anlageHints: ['Anlage 2'],
  },
  {
    key: 'unternehmensgegenstand', path: 'schuldner.unternehmensgegenstand', criticality: 'standard',
    label: 'Unternehmensgegenstand',
    anchors: ['Unternehmensgegenstand', 'Gegenstand des Unternehmens'],
  },
  {
    key: 'firma', path: 'schuldner.firma', criticality: 'critical',
    label: 'Firmenname',
    anchors: ['Firma', 'Name der Firma', 'Geschäftsbetrieb', 'Firmenbezeichnung'],
    anlageHints: ['Anlage 2'],
  },
  // ─── Tax & finance ───
  {
    key: 'finanzamt', path: 'schuldner.finanzamt', criticality: 'critical',
    label: 'Zuständiges Finanzamt',
    anchors: ['Finanzamt', 'zuständiges Finanzamt'],
  },
  {
    key: 'steuernummer', path: 'schuldner.steuernummer', criticality: 'standard',
    label: 'Steuernummer',
    anchors: ['Steuernummer', 'Steuer-Nr.', 'Steuer Nr'],
    negativeAnchors: ['Umsatzsteuer-ID', 'USt-ID'],
  },
  {
    key: 'ust_id', path: 'schuldner.ust_id', criticality: 'optional',
    label: 'Umsatzsteuer-ID',
    anchors: ['USt-ID', 'Umsatzsteuer-Identifikationsnummer', 'UStID'],
  },
  {
    key: 'steuerberater', path: 'schuldner.steuerberater', criticality: 'critical',
    label: 'Steuerberater (Name + Anschrift)',
    anchors: ['Steuerberater', 'Stb.', 'StB'],
    edgeCases: ['Name und Anschrift zusammen als einen String erfassen'],
  },
  {
    key: 'sozialversicherungstraeger', path: 'schuldner.sozialversicherungstraeger', criticality: 'standard',
    label: 'Sozialversicherungsträger / Krankenkasse',
    anchors: ['Sozialversicherungsträger', 'Krankenkasse', 'Krankenversicherung', 'AOK', 'DAK', 'TK', 'Barmer'],
  },
  {
    key: 'letzter_jahresabschluss', path: 'schuldner.letzter_jahresabschluss', criticality: 'optional',
    label: 'Datum des letzten Jahresabschlusses',
    anchors: ['letzter Jahresabschluss', 'Jahresabschluss zum', 'Bilanzstichtag'],
  },
  {
    key: 'bankverbindungen', path: 'schuldner.bankverbindungen', criticality: 'standard',
    label: 'Bankverbindungen',
    anchors: ['Bankverbindung', 'Kontoverbindung', 'IBAN', 'Bank'],
  },
  // ─── Personal status ───
  {
    key: 'familienstand', path: 'schuldner.familienstand', criticality: 'standard',
    label: 'Familienstand',
    anchors: ['Familienstand', 'ledig', 'verheiratet', 'geschieden', 'verwitwet'],
  },
  {
    key: 'geschlecht', path: 'schuldner.geschlecht', criticality: 'optional',
    label: 'Geschlecht',
    anchors: ['Geschlecht', 'männlich', 'weiblich', 'divers'],
  },
];

/** Subset of the registry whose entries trigger a gap-fill probe when empty. */
export function getCriticalFields(): HandwritingFieldDef[] {
  return HANDWRITING_FIELDS.filter(f => f.criticality === 'critical');
}

/**
 * Build the multi-field handwriting prompt — same shape as the legacy inline
 * HANDWRITING_PROMPT constant, but generated from the registry so adding a new
 * field in one place updates everything.
 */
export function buildMainPrompt(registry: HandwritingFieldDef[]): string {
  const fieldBullets = registry.map(f => {
    const negSuffix = f.negativeAnchors && f.negativeAnchors.length > 0
      ? ` (NICHT mit: ${f.negativeAnchors.join(', ')})`
      : '';
    return `- ${f.label}: ${f.anchors.slice(0, 4).join(' / ')}${negSuffix}`;
  }).join('\n');

  const schemaExample = registry.map(f => {
    const exampleVal = f.key === 'arbeitnehmer_anzahl' ? '2'
      : f.key === 'betriebsrat' ? 'false'
      : '"…"';
    return `  "${f.key}": {"wert": ${exampleVal}, "quelle": "Seite X, ${f.label}"}`;
  }).join(',\n');

  return `Du bist ein OCR-Spezialist für handschriftlich ausgefüllte deutsche Insolvenz-Fragebögen.

AUFGABE: Lies JEDES handschriftlich ausgefüllte Feld in diesen Formularseiten. Die Formulare sind vorgedruckt mit Feldnamen, und der Antragsteller hat die Werte HANDSCHRIFTLICH eingetragen.

Lies besonders sorgfältig:
${fieldBullets}
- Angekreuzte Checkboxen (☒ = ja, ☐ = nein)
- Beträge in EUR (auch handgeschriebene Zahlen)

Antworte AUSSCHLIESSLICH mit validem JSON. Für jedes gefundene Feld:
{
${schemaExample}
}

Wenn ein Feld leer ist oder nicht lesbar: NICHT aufnehmen. Nur tatsächlich gelesene Werte.`;
}

/**
 * Build a focused single-field prompt for the gap-fill pass. The prompt asks
 * ONLY about one target field, using the field's anchors, negativeAnchors, and
 * edgeCases from the registry. This is what makes the probe find values the
 * multi-field prompt missed due to attention dilution.
 */
export function buildProbePrompt(field: HandwritingFieldDef): string {
  const anchorLine = field.anchors.join(', ');
  const negLine = field.negativeAnchors && field.negativeAnchors.length > 0
    ? `\nNICHT verwechseln mit: ${field.negativeAnchors.join(', ')}.`
    : '';
  const edgeLines = field.edgeCases && field.edgeCases.length > 0
    ? `\n\nBesondere Regeln:\n- ${field.edgeCases.join('\n- ')}`
    : '';
  const anlageLine = field.anlageHints && field.anlageHints.length > 0
    ? `\nTypisch zu finden in: ${field.anlageHints.join(', ')}.`
    : '';

  return `Du schaust auf Seiten eines deutschen Insolvenz-Fragebogens. Viele Felder sind HANDSCHRIFTLICH ausgefüllt.

Fokussiere dich ausschließlich auf ein Feld: ${field.label}.

Häufige Feldbeschriftungen: ${anchorLine}.${negLine}${anlageLine}${edgeLines}

Antworte AUSSCHLIESSLICH mit JSON (keine Erklärung, keine Backticks):

{
  "${field.key}": {
    "wert": "<gefundener Wert>" oder null,
    "quelle": "Seite X, <kurze Beschreibung des Formularfelds>" oder null
  }
}`;
}

