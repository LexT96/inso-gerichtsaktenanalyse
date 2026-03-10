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
    if (typeof r.wert === 'number') return { wert: r.wert, quelle: r.quelle };
    // Handle German number format: "1.234,56" → 1234.56
    let raw = String(r.wert ?? '').trim();
    if (raw.includes(',')) {
      raw = raw.replace(/\./g, '').replace(',', '.');
    }
    const n = parseFloat(raw);
    return { wert: Number.isNaN(n) ? 0 : n, quelle: r.quelle };
  },
  z.object({ wert: z.number(), quelle: z.string() }).passthrough()
);

const sourcedBooleanSchema = z.preprocess(
  (v) => {
    const r = toSourcedValue(v);
    // Preserve null = "unknown / not investigated" vs false = "confirmed absent"
    if (r.wert === null || r.wert === undefined) return { wert: null, quelle: r.quelle };
    const s = String(r.wert).toLowerCase();
    const b = r.wert === true || s === 'ja' || s === 'true' || s === '1';
    return { wert: b, quelle: r.quelle };
  },
  z.object({ wert: z.boolean().nullable(), quelle: z.string() }).passthrough()
);

const defaultSourced = { wert: null, quelle: '' };
const defaultSourcedNum = { wert: 0, quelle: '' };
const defaultSourcedBool = { wert: null, quelle: '' };

// ─── Sub-schemas with full coercion ───

const forderungenSchema = z.preprocess(
  (v) => (v && Array.isArray(v) ? {} : ensureObject(v)),
  z.object({
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
      kinder: z.preprocess(ensureArray, z.array(z.any())).optional().default([]),
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
  zusammenfassung: z.preprocess(toString, z.string()).optional().default(''),
  risiken_hinweise: z.preprocess(ensureArray, z.array(stringOrObjectSchema)).optional().default([]),
});

export const extractionResultSchema = z.preprocess(ensureObject, extractionResultSchemaInner);

export type ValidatedExtractionResult = z.infer<typeof extractionResultSchema>;
