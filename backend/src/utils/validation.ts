import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// ─── Robust coercion helpers ───

function ensureObject(v: unknown): Record<string, unknown> {
  if (v != null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

function ensureArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  return [];
}

function toString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return String(o.wert ?? o.text ?? o.beschreibung ?? o.information ?? '');
  }
  return String(v);
}

// Accepts string or object (e.g. {wert, quelle}) and normalizes to string.
const stringOrObjectSchema = z.preprocess(
  (v) => toString(v),
  z.string()
);

// Normalizes any value to {wert, quelle} and preserves verifiziert if present
const toSourcedValue = (v: unknown): { wert: string | number | boolean | null; quelle: string; verifiziert?: boolean } => {
  if (v == null) return { wert: null, quelle: '' };
  if (typeof v === 'string') return { wert: v, quelle: '' };
  if (typeof v === 'number' || typeof v === 'boolean') return { wert: v, quelle: '' };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const w = o.wert;
    const result: { wert: string | number | boolean | null; quelle: string; verifiziert?: boolean } = {
      wert: w === null || w === undefined ? null : (w as string | number | boolean),
      quelle: String(o.quelle ?? ''),
    };
    if (typeof o.verifiziert === 'boolean') {
      result.verifiziert = o.verifiziert;
    }
    return result;
  }
  return { wert: null, quelle: '' };
};

const sourcedValueSchema = z.preprocess(
  toSourcedValue,
  z.object({ wert: z.union([z.string(), z.number(), z.boolean(), z.null()]), quelle: z.string() }).passthrough()
);

const sourcedNumberSchema = z.preprocess(
  (v) => {
    const r = toSourcedValue(v);
    if (typeof r.wert === 'number') return { ...r, wert: r.wert };
    // Handle German number format: "1.234,56" → 1234.56
    const raw = String(r.wert ?? '').trim();
    if (!raw) return { ...r, wert: null };
    const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
    const n = parseFloat(normalized);
    return { ...r, wert: Number.isNaN(n) ? null : n };
  },
  z.object({ wert: z.number().nullable(), quelle: z.string() }).passthrough()
);

const sourcedBooleanSchema = z.preprocess(
  (v) => {
    const r = toSourcedValue(v);
    // Preserve null = "unknown / not investigated" vs false = "confirmed absent"
    if (r.wert === null || r.wert === undefined) return { ...r, wert: null };
    if (r.wert === false) return { ...r, wert: false };
    if (r.wert === true) return { ...r, wert: true };
    const s = String(r.wert).toLowerCase().trim();
    // Explicit positive indicators
    if (s === 'ja' || s === 'true' || s === '1' || s === 'vorhanden' || s === 'abgegeben' || s === 'yes' || s === 'bestätigt') return { ...r, wert: true };
    // Explicit negative indicators (confirmed absent)
    if (s === 'nein' || s === 'false' || s === '0' || s === 'kein' || s === 'keine' || s === 'nicht vorhanden' || s === 'no') return { ...r, wert: false };
    // "Unknown" phrases → null (NOT false!) — investigation not done or result unclear
    if (s === 'nicht bekannt' || s === 'unbekannt' || s === 'nicht ermittelt' || s === 'nicht festgestellt' || s === 'nicht geprüft' || s === 'unklar' || s === 'offen') return { ...r, wert: null };
    // Negative prefix patterns (e.g. "kein Grundbesitz", "nicht deckend", "keine Daten gefunden")
    // AFTER the "unknown" check to avoid "nicht bekannt" → false
    if (s.startsWith('kein') || s.startsWith('nicht') || s.startsWith('keine daten')) return { ...r, wert: false };
    // Everything else is ambiguous → null (unknown), NOT true
    return { ...r, wert: null };
  },
  z.object({ wert: z.boolean().nullable(), quelle: z.string() }).passthrough()
);

const defaultSourced = { wert: null, quelle: '' };
const defaultSourcedNum = { wert: null, quelle: '' };
const defaultSourcedBool = { wert: null, quelle: '' };

// ─── Sub-schemas with full coercion ───

// ─── Forderungen sub-schemas ───

const SICHERHEIT_ART_VALUES = [
  'grundschuld', 'sicherungsuebereignung', 'eigentumsvorbehalt',
  'pfandrecht', 'buergschaft', 'sonstige',
] as const;

const sicherheitArtSchema = z.preprocess(
  (v) => {
    const s = String(v ?? '').toLowerCase().trim();
    if (SICHERHEIT_ART_VALUES.includes(s as typeof SICHERHEIT_ART_VALUES[number])) return s;
    if (s.includes('grundschuld') || s.includes('hypothek')) return 'grundschuld';
    if (s.includes('sicherungsüber') || s.includes('sicherungsueber')) return 'sicherungsuebereignung';
    if (s.includes('eigentumsvorbehalt') || s.includes('evb')) return 'eigentumsvorbehalt';
    if (s.includes('pfand')) return 'pfandrecht';
    if (s.includes('bürg') || s.includes('buerg')) return 'buergschaft';
    return 'sonstige';
  },
  z.enum(SICHERHEIT_ART_VALUES)
);

const FORDERUNGS_ART_VALUES = [
  'sozialversicherung', 'steuer', 'bank', 'lieferant',
  'arbeitnehmer', 'miete', 'sonstige',
] as const;

const forderungsArtSchema = z.preprocess(
  (v) => {
    const s = String(v ?? '').toLowerCase().trim();
    if (FORDERUNGS_ART_VALUES.includes(s as typeof FORDERUNGS_ART_VALUES[number])) return s;
    if (s.includes('krankenkasse') || s.includes('sozialversicher') || s.includes('rentenversicher') || s.includes('berufsgenoss') || s.includes('aok') || s.includes('barmer') || s.includes('tk') || s.includes('dak') || s.includes('knappschaft') || s.includes('beiträge') || s.includes('beitraege') || s.includes('sv-')) return 'sozialversicherung';
    if (s.includes('finanzamt') || s.includes('steuer') || s.includes('fiskus') || s.includes('zoll')) return 'steuer';
    if (s.includes('sparkasse') || s.includes('bank') || s.includes('volksbank') || s.includes('commerzbank') || s.includes('kredit') || s.includes('darlehen') || s.includes('hypo')) return 'bank';
    if (s.includes('arbeitnehmer') || s.includes('lohn') || s.includes('gehalt') || s.includes('mitarbeiter')) return 'arbeitnehmer';
    if (s.includes('miete') || s.includes('vermieter') || s.includes('pacht') || s.includes('miet')) return 'miete';
    if (s.includes('lieferant') || s.includes('lieferer') || s.includes('warenkredit') || s.includes('handwerker')) return 'lieferant';
    return 'sonstige';
  },
  z.enum(FORDERUNGS_ART_VALUES)
);

const FORDERUNGS_RANG_VALUES = [
  '§38 Insolvenzforderung', '§39 Nachrangig', 'Masseforderung §55',
] as const;

const forderungsRangSchema = z.preprocess(
  (v) => {
    const s = String(v ?? '').toLowerCase().trim();
    if (s.includes('nachrang') || s.includes('§39') || s.includes('§ 39')) return '§39 Nachrangig';
    if (s.includes('masse') || s.includes('§55') || s.includes('§ 55')) return 'Masseforderung §55';
    // Default: normal insolvency claim
    return '§38 Insolvenzforderung';
  },
  z.enum(FORDERUNGS_RANG_VALUES)
);

const sicherheitSchema = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return undefined;
    return ensureObject(v);
  },
  z.object({
    art: sicherheitArtSchema.optional().default('sonstige'),
    gegenstand: sourcedValueSchema.optional().default(defaultSourced),
    geschaetzter_wert: sourcedNumberSchema.optional().default(defaultSourcedNum),
    absonderungsberechtigt: z.preprocess(
      (v) => v === true || v === 'true' || v === 'ja',
      z.boolean()
    ).optional().default(true),
  }).optional()
);

const einzelforderungSchema = z.preprocess(
  (v) => ensureObject(v),
  z.object({
    glaeubiger: sourcedValueSchema.optional().default(defaultSourced),
    art: forderungsArtSchema.optional().default('sonstige'),
    rang: forderungsRangSchema.optional().default('§38 Insolvenzforderung'),
    betrag: sourcedNumberSchema.optional().default(defaultSourcedNum),
    zeitraum_von: sourcedValueSchema.optional().default(defaultSourced),
    zeitraum_bis: sourcedValueSchema.optional().default(defaultSourced),
    titel: sourcedValueSchema.optional().default(defaultSourced),
    sicherheit: sicherheitSchema.optional(),
    ist_antragsteller: z.preprocess(
      (v) => v === true || v === 'true' || v === 'ja',
      z.boolean()
    ).optional().default(false),
  })
);

function migrateOldForderungen(v: unknown): Record<string, unknown> {
  const obj = v && Array.isArray(v) ? {} : ensureObject(v);
  if (Array.isArray(obj.einzelforderungen)) return obj;
  // Old format detected
  if ('hauptforderung_beitraege' in obj || 'gesamtforderung' in obj) {
    const betrag = obj.gesamtforderung ?? obj.hauptforderung_beitraege ?? { wert: null, quelle: '' };
    const synthesized = {
      glaeubiger: { wert: 'Antragsteller', quelle: '' },
      art: 'sozialversicherung',
      rang: '§38 Insolvenzforderung',
      betrag,
      zeitraum_von: obj.zeitraum_von ?? { wert: null, quelle: '' },
      zeitraum_bis: obj.zeitraum_bis ?? { wert: null, quelle: '' },
      titel: { wert: null, quelle: '' },
      ist_antragsteller: true,
    };
    return {
      // New fields first (cannot be overridden by legacy spread)
      einzelforderungen: [synthesized],
      gesamtforderungen: obj.gesamtforderung ?? { wert: null, quelle: '' },
      gesicherte_forderungen: { wert: null, quelle: '' },
      ungesicherte_forderungen: { wert: null, quelle: '' },
      // Legacy fields explicitly (no spread to avoid override)
      hauptforderung_beitraege: obj.hauptforderung_beitraege,
      saeumniszuschlaege: obj.saeumniszuschlaege,
      mahngebuehren: obj.mahngebuehren,
      vollstreckungskosten: obj.vollstreckungskosten,
      antragskosten: obj.antragskosten,
      gesamtforderung: obj.gesamtforderung,
      zeitraum_von: obj.zeitraum_von,
      zeitraum_bis: obj.zeitraum_bis,
      laufende_monatliche_beitraege: obj.laufende_monatliche_beitraege,
      betroffene_arbeitnehmer: obj.betroffene_arbeitnehmer ?? [],
    };
  }
  return { einzelforderungen: [], ...obj };
}

const forderungenSchema = z.preprocess(
  migrateOldForderungen,
  z.object({
    einzelforderungen: z.preprocess(ensureArray, z.array(einzelforderungSchema)).optional().default([]),
    gesamtforderungen: sourcedNumberSchema.optional().default(defaultSourcedNum),
    gesicherte_forderungen: sourcedNumberSchema.optional().default(defaultSourcedNum),
    ungesicherte_forderungen: sourcedNumberSchema.optional().default(defaultSourcedNum),
    // Legacy fields (optional, backward compat with existing DB records)
    hauptforderung_beitraege: sourcedNumberSchema.optional().default(defaultSourcedNum),
    saeumniszuschlaege: sourcedNumberSchema.optional().default(defaultSourcedNum),
    mahngebuehren: sourcedNumberSchema.optional().default(defaultSourcedNum),
    vollstreckungskosten: sourcedNumberSchema.optional().default(defaultSourcedNum),
    antragskosten: sourcedNumberSchema.optional().default(defaultSourcedNum),
    gesamtforderung: sourcedNumberSchema.optional().default(defaultSourcedNum),
    zeitraum_von: sourcedValueSchema.optional().default(defaultSourced),
    zeitraum_bis: sourcedValueSchema.optional().default(defaultSourced),
    laufende_monatliche_beitraege: sourcedNumberSchema.optional().default(defaultSourcedNum),
    betroffene_arbeitnehmer: z.array(z.any()).optional().default([]),
  })
);

const ermittlungsergebnisseSchema = z.preprocess(
  (v) => (v && Array.isArray(v) ? {} : ensureObject(v)),
  z.object({
    grundbuch: z
      .object({
        ergebnis: sourcedValueSchema.optional().default(defaultSourced),
        grundbesitz_vorhanden: sourcedBooleanSchema.optional().default(defaultSourcedBool),
        datum: sourcedValueSchema.optional().default(defaultSourced),
      })
      .optional()
      .default({ ergebnis: defaultSourced, grundbesitz_vorhanden: defaultSourcedBool, datum: defaultSourced }),
    gerichtsvollzieher: z
      .object({
        name: sourcedValueSchema.optional().default(defaultSourced),
        betriebsstaette_bekannt: sourcedBooleanSchema.optional().default(defaultSourcedBool),
        vollstreckungen: sourcedValueSchema.optional().default(defaultSourced),
        masse_deckend: sourcedBooleanSchema.optional().default(defaultSourcedBool),
        vermoegensauskunft_abgegeben: sourcedBooleanSchema.optional().default(defaultSourcedBool),
        haftbefehle: sourcedBooleanSchema.optional().default(defaultSourcedBool),
        datum: sourcedValueSchema.optional().default(defaultSourced),
      })
      .optional()
      .default({
        name: defaultSourced,
        betriebsstaette_bekannt: defaultSourcedBool,
        vollstreckungen: defaultSourced,
        masse_deckend: defaultSourcedBool,
        vermoegensauskunft_abgegeben: defaultSourcedBool,
        haftbefehle: defaultSourcedBool,
        datum: defaultSourced,
      }),
    vollstreckungsportal: z
      .object({
        schuldnerverzeichnis_eintrag: sourcedBooleanSchema.optional().default(defaultSourcedBool),
        vermoegensverzeichnis_eintrag: sourcedBooleanSchema.optional().default(defaultSourcedBool),
      })
      .optional()
      .default({ schuldnerverzeichnis_eintrag: defaultSourcedBool, vermoegensverzeichnis_eintrag: defaultSourcedBool }),
    meldeauskunft: z
      .object({
        meldestatus: sourcedValueSchema.optional().default(defaultSourced),
        datum: sourcedValueSchema.optional().default(defaultSourced),
      })
      .optional()
      .default({ meldestatus: defaultSourced, datum: defaultSourced }),
  })
);

const fristItemSchema = z.preprocess(
  (v) => ensureObject(v),
  z.object({
    bezeichnung: stringOrObjectSchema.optional().default(''),
    datum: stringOrObjectSchema.optional().default(''),
    status: stringOrObjectSchema.optional().default(''),
    quelle: stringOrObjectSchema.optional().default(''),
  })
);

const standardanschreibenItemSchema = z.preprocess(
  (v) => ensureObject(v),
  z.object({
    typ: stringOrObjectSchema.optional().default(''),
    empfaenger: stringOrObjectSchema.optional().default(''),
    status: z.preprocess(
      (val) => {
        const s = val && typeof val === 'object'
          ? String((val as Record<string, unknown>).wert ?? '')
          : String(val ?? '');
        const lower = s.toLowerCase();
        if (lower === 'bereit') return 'bereit';
        if (lower === 'entfaellt') return 'entfaellt';
        return 'fehlt';
      },
      z.enum(['bereit', 'fehlt', 'entfaellt'])
    ),
    begruendung: stringOrObjectSchema.optional().default(''),
    fehlende_daten: z.preprocess((val) => ensureArray(val), z.array(stringOrObjectSchema)).optional().default([]),
  })
);

function normalizeFehlendInfoItem(v: unknown): Record<string, unknown> {
  if (v != null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const info = toString(o.information ?? '');
    const grund = toString(o.grund ?? '');
    const ermittlung = toString(o.ermittlung_ueber ?? '');
    return { information: info, grund, ermittlung_ueber: ermittlung };
  }
  // Plain string from AI: use as information
  if (typeof v === 'string' && v.trim()) {
    return { information: v.trim(), grund: '', ermittlung_ueber: '' };
  }
  return { information: '', grund: '', ermittlung_ueber: '' };
}

const fehlendeInfoItemSchema = z.preprocess(
  normalizeFehlendInfoItem,
  z.object({
    information: z.string(),
    grund: z.string(),
    ermittlung_ueber: z.string(),
  })
);

// ─── Aktiva schema ───

const AKTIVA_KATEGORIE_VALUES = [
  'immobilien', 'fahrzeuge', 'bankguthaben', 'lebensversicherungen',
  'wertpapiere_beteiligungen', 'forderungen_schuldner', 'bewegliches_vermoegen',
  'geschaeftsausstattung', 'steuererstattungen', 'einkommen',
] as const;

const aktivaKategorieSchema = z.preprocess(
  (v) => {
    const s = String(v ?? '').toLowerCase().trim();
    if (AKTIVA_KATEGORIE_VALUES.includes(s as typeof AKTIVA_KATEGORIE_VALUES[number])) return s;
    if (s.includes('immobil') || s.includes('grundst') || s.includes('grundbes') || s.includes('haus') || s.includes('wohnung')) return 'immobilien';
    if (s.includes('fahrzeug') || s.includes('kfz') || s.includes('auto') || s.includes('pkw')) return 'fahrzeuge';
    if (s.includes('bank') || s.includes('konto') || s.includes('guthab') || s.includes('bargeld')) return 'bankguthaben';
    if (s.includes('versicherung') || s.includes('lebensv') || s.includes('rueckkauf')) return 'lebensversicherungen';
    if (s.includes('wertpap') || s.includes('beteilig') || s.includes('aktie') || s.includes('anteil')) return 'wertpapiere_beteiligungen';
    if (s.includes('forderung')) return 'forderungen_schuldner';
    if (s.includes('geschaeft') || s.includes('betriebs') || s.includes('ausstattung')) return 'geschaeftsausstattung';
    if (s.includes('steuer') || s.includes('erstattung')) return 'steuererstattungen';
    if (s.includes('einkommen') || s.includes('pfaend') || s.includes('gehalt') || s.includes('lohn')) return 'einkommen';
    return 'bewegliches_vermoegen';
  },
  z.enum(AKTIVA_KATEGORIE_VALUES)
);

const aktivumSchema = z.preprocess(
  (v) => ensureObject(v),
  z.object({
    beschreibung: sourcedValueSchema.optional().default(defaultSourced),
    geschaetzter_wert: sourcedNumberSchema.optional().default(defaultSourcedNum),
    kategorie: aktivaKategorieSchema.optional().default('bewegliches_vermoegen'),
    liquidationswert: sourcedNumberSchema.optional(),
    fortfuehrungswert: sourcedNumberSchema.optional(),
    absonderung: sourcedNumberSchema.optional(),
    aussonderung: sourcedNumberSchema.optional(),
    freie_masse: sourcedNumberSchema.optional(),
    sicherungsrechte: z.string().optional(),
  })
);

const insolvenzgrundBewertungSchema = z.preprocess(
  (v) => ensureObject(v),
  z.object({
    status: z.preprocess(
      (v) => {
        const s = String(v ?? 'offen').toLowerCase().trim();
        if (s === 'ja' || s === 'true') return 'ja';
        if (s === 'nein' || s === 'false') return 'nein';
        return 'offen';
      },
      z.enum(['ja', 'nein', 'offen'])
    ),
    begruendung: z.preprocess((v) => String(v ?? ''), z.string()),
  })
);

const defaultBewertung = { status: 'offen', begruendung: '' };

const insolvenzanalyseSchema = z.preprocess(
  (v) => ensureObject(v),
  z.object({
    zahlungsunfaehigkeit_17: insolvenzgrundBewertungSchema.optional().default(defaultBewertung),
    drohende_zahlungsunfaehigkeit_18: insolvenzgrundBewertungSchema.optional().default(defaultBewertung),
    ueberschuldung_19: insolvenzgrundBewertungSchema.optional().default(defaultBewertung),
    massekostendeckung_26: insolvenzgrundBewertungSchema.optional().default(defaultBewertung),
    gesamtbewertung: z.preprocess((v) => String(v ?? ''), z.string()),
  })
);

const aktivaAnalyseSchema = z.preprocess(
  (v) => ensureObject(v),
  z.object({
    positionen: z.preprocess(ensureArray, z.array(aktivumSchema)).optional().default([]),
    summe_aktiva: sourcedNumberSchema.optional().default(defaultSourcedNum),
    massekosten_schaetzung: sourcedNumberSchema.optional().default(defaultSourcedNum),
    insolvenzanalyse: insolvenzanalyseSchema.optional(),
  })
);

// ─── Anfechtung schema ───

const ANFECHTUNGS_GRUNDLAGE_VALUES = [
  '§130 Kongruente Deckung', '§131 Inkongruente Deckung',
  '§132 Unmittelbar nachteilige Rechtshandlung', '§133 Vorsätzliche Benachteiligung',
  '§134 Unentgeltliche Leistung', '§135 Gesellschafterdarlehen', '§142 Bargeschäft',
] as const;

const anfechtungsGrundlageSchema = z.preprocess(
  (v) => {
    const s = String(v ?? '').trim();
    for (const g of ANFECHTUNGS_GRUNDLAGE_VALUES) {
      if (s.includes(g) || s.toLowerCase().includes(g.split(' ').slice(1).join(' ').toLowerCase())) return g;
    }
    if (s.includes('130') || s.toLowerCase().includes('kongruent')) return '§130 Kongruente Deckung';
    if (s.includes('131') || s.toLowerCase().includes('inkongruent')) return '§131 Inkongruente Deckung';
    if (s.includes('133') || s.toLowerCase().includes('vorsätzlich') || s.toLowerCase().includes('vorsaetzlich')) return '§133 Vorsätzliche Benachteiligung';
    if (s.includes('134') || s.toLowerCase().includes('unentgeltlich')) return '§134 Unentgeltliche Leistung';
    if (s.includes('135') || s.toLowerCase().includes('gesellschafter')) return '§135 Gesellschafterdarlehen';
    if (s.includes('142') || s.toLowerCase().includes('bargeschäft') || s.toLowerCase().includes('bargeschaeft')) return '§142 Bargeschäft';
    return '§130 Kongruente Deckung';
  },
  z.enum(ANFECHTUNGS_GRUNDLAGE_VALUES)
);

const anfechtbarerVorgangSchema = z.preprocess(
  (v) => ensureObject(v),
  z.object({
    beschreibung: sourcedValueSchema.optional().default(defaultSourced),
    betrag: sourcedNumberSchema.optional().default(defaultSourcedNum),
    datum: sourcedValueSchema.optional().default(defaultSourced),
    empfaenger: sourcedValueSchema.optional().default(defaultSourced),
    grundlage: anfechtungsGrundlageSchema.optional().default('§130 Kongruente Deckung'),
    risiko: z.preprocess(
      (v) => { const s = String(v ?? 'gering').toLowerCase(); return s.includes('hoch') ? 'hoch' : s.includes('mittel') ? 'mittel' : 'gering'; },
      z.enum(['hoch', 'mittel', 'gering'])
    ).optional().default('gering'),
    begruendung: z.preprocess((v) => String(v ?? ''), z.string()),
    anfechtbar_ab: z.preprocess((v) => String(v ?? ''), z.string()),
    ist_nahestehend: z.preprocess((v) => v === true || v === 'true' || v === 'ja', z.boolean()).optional().default(false),
  })
);

const anfechtungsanalyseSchema = z.preprocess(
  (v) => ensureObject(v),
  z.object({
    vorgaenge: z.preprocess(ensureArray, z.array(anfechtbarerVorgangSchema)).optional().default([]),
    gesamtpotenzial: sourcedNumberSchema.optional().default(defaultSourcedNum),
    zusammenfassung: z.preprocess((v) => String(v ?? ''), z.string()),
  })
);

// ─── Erweiterte Schuldner schemas ───

const ehegatteSchema = z.preprocess(
  (v) => { if (!v || v === null) return undefined; return ensureObject(v); },
  z.object({
    name: sourcedValueSchema.optional().default(defaultSourced),
    geburtsdatum: sourcedValueSchema.optional().default(defaultSourced),
    gueterstand: z.preprocess(
      (v) => { const s = String(v ?? 'unbekannt').toLowerCase(); if (s.includes('trennung')) return 'guetertrennung'; if (s.includes('gemeinschaft') && !s.includes('zugewinn')) return 'guetergemeinschaft'; if (s.includes('zugewinn')) return 'zugewinngemeinschaft'; return 'unbekannt'; },
      z.enum(['zugewinngemeinschaft', 'guetertrennung', 'guetergemeinschaft', 'unbekannt'])
    ).optional().default('unbekannt'),
    gemeinsames_eigentum: sourcedValueSchema.optional().default(defaultSourced),
  }).optional()
);

const beschaeftigungSchema = z.preprocess(
  (v) => { if (!v || v === null) return undefined; return ensureObject(v); },
  z.object({
    arbeitgeber: sourcedValueSchema.optional().default(defaultSourced),
    arbeitgeber_adresse: sourcedValueSchema.optional().default(defaultSourced),
    nettoeinkommen: sourcedNumberSchema.optional().default(defaultSourcedNum),
    beschaeftigt_seit: sourcedValueSchema.optional().default(defaultSourced),
    art: sourcedValueSchema.optional().default(defaultSourced),
  }).optional()
);

const pfaendungsberechnungSchema = z.preprocess(
  (v) => { if (!v || v === null) return undefined; return ensureObject(v); },
  z.object({
    nettoeinkommen: sourcedNumberSchema.optional().default(defaultSourcedNum),
    unterhaltspflichten: sourcedNumberSchema.optional().default(defaultSourcedNum),
    pfaendbarer_betrag: sourcedNumberSchema.optional().default(defaultSourcedNum),
  }).optional()
);

// ─── Root schema: 100% robust ───

const extractionResultSchemaInner = z.object({
  verfahrensdaten: z
    .preprocess(ensureObject, z.object({
      aktenzeichen: sourcedValueSchema.optional().default(defaultSourced),
      gericht: sourcedValueSchema.optional().default(defaultSourced),
      richter: sourcedValueSchema.optional().default(defaultSourced),
      antragsdatum: sourcedValueSchema.optional().default(defaultSourced),
      beschlussdatum: sourcedValueSchema.optional().default(defaultSourced),
      antragsart: sourcedValueSchema.optional().default(defaultSourced),
      eroeffnungsgrund: sourcedValueSchema.optional().default(defaultSourced),
      zustellungsdatum_schuldner: sourcedValueSchema.optional().default(defaultSourced),
      verfahrensstadium: sourcedValueSchema.optional().default(defaultSourced),
      verfahrensart: sourcedValueSchema.optional().default(defaultSourced),
      internationaler_bezug: sourcedBooleanSchema.optional().default(defaultSourcedBool),
      eigenverwaltung: sourcedBooleanSchema.optional().default(defaultSourcedBool),
    }))
    .optional()
    .default({}),
  schuldner: z
    .preprocess(ensureObject, z.object({
      name: sourcedValueSchema.optional().default(defaultSourced),
      vorname: sourcedValueSchema.optional().default(defaultSourced),
      geburtsdatum: sourcedValueSchema.optional().default(defaultSourced),
      geburtsort: sourcedValueSchema.optional().default(defaultSourced),
      geburtsland: sourcedValueSchema.optional().default(defaultSourced),
      staatsangehoerigkeit: sourcedValueSchema.optional().default(defaultSourced),
      familienstand: sourcedValueSchema.optional().default(defaultSourced),
      geschlecht: sourcedValueSchema.optional().default(defaultSourced),
      aktuelle_adresse: sourcedValueSchema.optional().default(defaultSourced),
      fruehere_adressen: z.preprocess(ensureArray, z.array(z.any())).optional().default([]),
      firma: sourcedValueSchema.optional().default(defaultSourced),
      rechtsform: sourcedValueSchema.optional().default(defaultSourced),
      betriebsstaette_adresse: sourcedValueSchema.optional().default(defaultSourced),
      handelsregisternummer: sourcedValueSchema.optional().default(defaultSourced),
      telefon: sourcedValueSchema.optional().default(defaultSourced),
      mobiltelefon: sourcedValueSchema.optional().default(defaultSourced),
      email: sourcedValueSchema.optional().default(defaultSourced),
      kinder: z.preprocess(ensureArray, z.array(z.any())).optional().default([]),
      // Erweiterte Daten (natürliche Person)
      ehegatte: ehegatteSchema.optional(),
      beschaeftigung: beschaeftigungSchema.optional(),
      pfaendungsberechnung: pfaendungsberechnungSchema.optional(),
      // Unternehmensdaten (juristische Person / Einzelunternehmen)
      satzungssitz: sourcedValueSchema.optional().default(defaultSourced),
      verwaltungssitz: sourcedValueSchema.optional().default(defaultSourced),
      unternehmensgegenstand: sourcedValueSchema.optional().default(defaultSourced),
      geschaeftszweig: sourcedValueSchema.optional().default(defaultSourced),
      stammkapital: sourcedValueSchema.optional().default(defaultSourced),
      gesellschafter: z.preprocess(ensureArray, z.array(z.object({
        name: z.string().default(''),
        sitz: z.string().default(''),
        beteiligung: z.string().default(''),
      }))).optional().default([]),
      geschaeftsfuehrer: sourcedValueSchema.optional().default(defaultSourced),
      prokurist: sourcedValueSchema.optional().default(defaultSourced),
      gruendungsdatum: sourcedValueSchema.optional().default(defaultSourced),
      hr_eintragung_datum: sourcedValueSchema.optional().default(defaultSourced),
      groessenklasse_hgb: sourcedValueSchema.optional().default(defaultSourced),
      dundo_versicherung: sourcedValueSchema.optional().default(defaultSourced),
      arbeitnehmer_anzahl: sourcedNumberSchema.optional().default(defaultSourcedNum),
      betriebsrat: sourcedBooleanSchema.optional().default(defaultSourcedBool),
      // Steuerliche Angaben
      finanzamt: sourcedValueSchema.optional().default(defaultSourced),
      steuernummer: sourcedValueSchema.optional().default(defaultSourced),
      ust_id: sourcedValueSchema.optional().default(defaultSourced),
      wirtschaftsjahr: sourcedValueSchema.optional().default(defaultSourced),
      ust_versteuerung: sourcedValueSchema.optional().default(defaultSourced),
      steuerliche_organschaft: sourcedBooleanSchema.optional().default(defaultSourcedBool),
      letzter_jahresabschluss: sourcedValueSchema.optional().default(defaultSourced),
      // Sonstige
      sozialversicherungstraeger: sourcedValueSchema.optional().default(defaultSourced),
      steuerberater: sourcedValueSchema.optional().default(defaultSourced),
      bankverbindungen: sourcedValueSchema.optional().default(defaultSourced),
      insolvenzsonderkonto: sourcedValueSchema.optional().default(defaultSourced),
    }))
    .optional()
    .default({}),
  antragsteller: z
    .preprocess(ensureObject, z.object({
      name: sourcedValueSchema.optional().default(defaultSourced),
      adresse: sourcedValueSchema.optional().default(defaultSourced),
      ansprechpartner: sourcedValueSchema.optional().default(defaultSourced),
      telefon: sourcedValueSchema.optional().default(defaultSourced),
      fax: sourcedValueSchema.optional().default(defaultSourced),
      email: sourcedValueSchema.optional().default(defaultSourced),
      betriebsnummer: sourcedValueSchema.optional().default(defaultSourced),
      bankverbindung_iban: sourcedValueSchema.optional().default(defaultSourced),
      bankverbindung_bic: sourcedValueSchema.optional().default(defaultSourced),
    }))
    .optional()
    .default({}),
  forderungen: forderungenSchema.optional().default({}),
  gutachterbestellung: z
    .preprocess(ensureObject, z.object({
      gutachter_name: sourcedValueSchema.optional().default(defaultSourced),
      gutachter_kanzlei: sourcedValueSchema.optional().default(defaultSourced),
      gutachter_adresse: sourcedValueSchema.optional().default(defaultSourced),
      gutachter_telefon: sourcedValueSchema.optional().default(defaultSourced),
      gutachter_email: sourcedValueSchema.optional().default(defaultSourced),
      abgabefrist: sourcedValueSchema.optional().default(defaultSourced),
      befugnisse: z.preprocess(ensureArray, z.array(stringOrObjectSchema)).optional().default([]),
    }))
    .optional()
    .default({}),
  ermittlungsergebnisse: ermittlungsergebnisseSchema.optional().default({}),
  fristen: z.preprocess(ensureArray, z.array(fristItemSchema)).optional().default([]),
  standardanschreiben: z.preprocess(ensureArray, z.array(standardanschreibenItemSchema)).optional().default([]),
  fehlende_informationen: z.preprocess(
    (v) => {
      const arr = ensureArray(v);
      return arr
        .map(normalizeFehlendInfoItem)
        .filter((item) => String(item.information ?? '').trim() !== '');
    },
    z.array(fehlendeInfoItemSchema)
  ).optional().default([]),
  zusammenfassung: z.preprocess(
    (v) => {
      // Backward compat: old format was a plain string → convert to single sourced item
      if (typeof v === 'string' && v.trim()) return [{ wert: v.trim(), quelle: '' }];
      if (typeof v === 'string') return [];
      return ensureArray(v);
    },
    z.array(sourcedValueSchema)
  ).optional().default([]),
  risiken_hinweise: z.preprocess(
    (v) => {
      // Backward compat: old format was string[] → convert each to sourced item
      const arr = ensureArray(v);
      return arr.map((item: unknown) => {
        if (typeof item === 'string') return { wert: item, quelle: '' };
        return item;
      });
    },
    z.array(sourcedValueSchema)
  ).optional().default([]),
  aktiva: aktivaAnalyseSchema.optional(),
  anfechtung: anfechtungsanalyseSchema.optional(),
});

export const extractionResultSchema = z.preprocess(ensureObject, extractionResultSchemaInner);

export type ValidatedExtractionResult = z.infer<typeof extractionResultSchema>;
