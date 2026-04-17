import { useMemo } from 'react';
import { DataField } from '../DataField';
import { Section } from '../Section';
import { EmptyState } from '../EmptyState';
import type { AktivaAnalyse, AktivaKategorie, Aktivum, Forderungen, Schuldner, InsolvenzgrundBewertung } from '../../../types/extraction';

const KATEGORIE_LABELS: Record<AktivaKategorie, string> = {
  immobilien: 'Immobilien (Grundbesitz)',
  fahrzeuge: 'Fahrzeuge (KFZ)',
  bankguthaben: 'Bankguthaben & Bargeld',
  lebensversicherungen: 'Lebensversicherungen',
  wertpapiere_beteiligungen: 'Wertpapiere & Beteiligungen',
  forderungen_schuldner: 'Forderungen des Schuldners',
  bewegliches_vermoegen: 'Bewegliches Vermögen (Hausrat)',
  geschaeftsausstattung: 'Geschäftsausstattung',
  steuererstattungen: 'Steuererstattungsansprüche',
  einkommen: 'Pfändbare Einkommensbestandteile',
};

const KATEGORIE_ICONS: Record<AktivaKategorie, string> = {
  immobilien: '▤',
  fahrzeuge: '◈',
  bankguthaben: '◉',
  lebensversicherungen: '◎',
  wertpapiere_beteiligungen: '◇',
  forderungen_schuldner: '◊',
  bewegliches_vermoegen: '▣',
  geschaeftsausstattung: '◆',
  steuererstattungen: '○',
  einkommen: '●',
};

const KATEGORIE_ORDER: AktivaKategorie[] = [
  'immobilien', 'fahrzeuge', 'bankguthaben', 'lebensversicherungen',
  'wertpapiere_beteiligungen', 'forderungen_schuldner', 'bewegliches_vermoegen',
  'geschaeftsausstattung', 'steuererstattungen', 'einkommen',
];

const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

function getNum(field: { wert: number | null } | null | undefined): number | null {
  if (!field) return null;
  const v = field.wert;
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  // Handle German number format: "100.608,33" → 100608.33
  const s = String(v).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/**
 * Berechne Regelvergütung nach § 2 Abs. 1 InsVV.
 * Degressiver Staffeltarif (7 Stufen) auf Basis der Berechnungsgrundlage
 * (= Insolvenzmasse bei Schlussverteilung, § 1 InsVV).
 *
 * § 2 Abs. 1 InsVV:
 *   Nr. 1: von den ersten 25.000 EUR: 40%
 *   Nr. 2: Mehrbetrag bis 50.000 EUR: 25%
 *   Nr. 3: Mehrbetrag bis 250.000 EUR: 7%
 *   Nr. 4: Mehrbetrag bis 500.000 EUR: 3%
 *   Nr. 5: Mehrbetrag bis 25.000.000 EUR: 2%
 *   Nr. 6: Mehrbetrag bis 50.000.000 EUR: 1%
 *   Nr. 7: darüber hinaus: 0,5%
 *
 * § 2 Abs. 2 InsVV: Mindestvergütung 1.000 EUR.
 *
 * Gerichtskosten: Pauschale nach GKG KV Nr. 2310 (Verfahrenseröffnung).
 * Exakter Wert hängt vom Streitwert ab — hier vereinfacht als Stufentabelle.
 */
function berechneInsVV(berechnungsgrundlage: number): {
  verguetung: number; gerichtskosten: number; gesamt: number;
  stufen: { von: number; bis: number; satz: number; betrag: number }[];
} {
  const STUFEN = [
    { bis: 25_000,      satz: 0.40 },
    { bis: 50_000,      satz: 0.25 },
    { bis: 250_000,     satz: 0.07 },
    { bis: 500_000,     satz: 0.03 },
    { bis: 25_000_000,  satz: 0.02 },
    { bis: 50_000_000,  satz: 0.01 },
    { bis: Infinity,    satz: 0.005 },
  ];

  let verguetung = 0;
  let rest = Math.max(0, berechnungsgrundlage);
  let prevBis = 0;
  const stufenDetail: { von: number; bis: number; satz: number; betrag: number }[] = [];

  for (const { bis, satz } of STUFEN) {
    const stufenBreite = bis === Infinity ? rest : bis - prevBis;
    const stufenBetrag = Math.min(rest, stufenBreite);
    if (stufenBetrag <= 0) break;
    const betrag = Math.round(stufenBetrag * satz * 100) / 100;
    verguetung += betrag;
    stufenDetail.push({ von: prevBis, bis: bis === Infinity ? prevBis + stufenBetrag : bis, satz, betrag });
    rest -= stufenBetrag;
    prevBis = bis === Infinity ? prevBis : bis;
  }

  // § 2 Abs. 2 InsVV: Mindestvergütung 1.000 EUR
  verguetung = Math.max(verguetung, 1000);

  // Gerichtskosten: GKG KV Nr. 2310 (vereinfachte Stufentabelle)
  // Quelle: GKG Anlage 2, Gebührentabelle (Stand 2025)
  const GKG_STUFEN: [number, number][] = [
    [500, 38], [1000, 58], [1500, 78], [2000, 98], [3000, 119],
    [4000, 140], [5000, 161], [6000, 182], [7000, 203], [8000, 224],
    [9000, 245], [10000, 266], [13000, 295], [16000, 324], [19000, 353],
    [22000, 382], [25000, 411], [30000, 449], [35000, 487], [40000, 525],
    [45000, 563], [50000, 601], [65000, 733], [80000, 865], [95000, 997],
    [110000, 1129], [125000, 1261], [140000, 1393], [155000, 1525],
    [170000, 1657], [185000, 1789], [200000, 1921], [230000, 2119],
    [260000, 2317], [290000, 2515], [320000, 2713], [350000, 2911],
    [380000, 3109], [410000, 3307], [440000, 3505], [470000, 3703],
    [500000, 3901],
  ];
  let gebuehr = 3901; // Default für > 500.000 EUR
  for (const [grenze, wert] of GKG_STUFEN) {
    if (berechnungsgrundlage <= grenze) { gebuehr = wert; break; }
  }
  // GKG KV Nr. 2310: 1,5 Gebühren für Eröffnung Insolvenzverfahren
  // (0,5 Gebühren Eröffnungsantrag + 1,0 Gebühr Durchführung des Eröffnungsverfahrens)
  const gerichtskosten = Math.round(gebuehr * 1.5 * 100) / 100;

  return {
    verguetung: Math.round(verguetung * 100) / 100,
    gerichtskosten,
    gesamt: Math.round((verguetung + gerichtskosten) * 100) / 100,
    stufen: stufenDetail,
  };
}

/** Check if rechtsform suggests a juristische Person (GmbH, AG, UG, etc.) */
function isJuristischePerson(schuldner: Schuldner): boolean {
  const rf = schuldner?.rechtsform?.wert;
  if (!rf || typeof rf !== 'string') return false;
  const lower = rf.toLowerCase();
  return /gmbh|ag\b|ug\b|kg\b|ohg|gbr|e\.?\s?v\.?|genos|stiftung|verein|se\b|kga|partg/i.test(lower)
    || lower.includes('juristische')
    || lower.includes('gesellschaft')
    || lower.includes('kapitalgesellschaft');
}

const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  ja: { bg: 'bg-red-400/10 border-red-400/30', text: 'text-red-400', label: 'JA' },
  nein: { bg: 'bg-emerald-400/10 border-emerald-400/30', text: 'text-emerald-400', label: 'NEIN' },
  offen: { bg: 'bg-amber-400/10 border-amber-400/30', text: 'text-amber-400', label: 'OFFEN' },
};

function BewertungRow({ label, bewertung }: { label: string; bewertung: InsolvenzgrundBewertung }) {
  const s = STATUS_COLORS[bewertung.status] || STATUS_COLORS.offen;
  return (
    <div className="py-2 border-b border-border">
      <div className="flex items-center gap-3 mb-1">
        <span className="flex-shrink-0 w-[220px] text-[11px] text-text-dim font-sans">{label}</span>
        <span className={`px-2 py-0.5 rounded-md border text-[9px] font-bold font-mono ${s.bg} ${s.text}`}>
          {s.label}
        </span>
      </div>
      {bewertung.begruendung && (
        <div className="ml-[220px] pl-3 text-[10px] text-text-muted font-mono leading-relaxed">
          {bewertung.begruendung}
        </div>
      )}
    </div>
  );
}

function FallbackRow({ label, result, hidden, invert }: { label: string; result: boolean | null; hidden?: boolean; invert?: boolean }) {
  if (hidden) return null;
  const positive = invert ? result === true : result === false;
  const negative = invert ? result === false : result === true;
  return (
    <div className="flex items-start gap-3 py-1.5 border-b border-border">
      <span className="flex-shrink-0 w-[220px] text-[11px] text-text-dim font-sans">{label}</span>
      <div className="flex-1">
        {result === null ? (
          <span className="text-xs font-mono text-text-muted">— Daten unvollständig</span>
        ) : negative ? (
          <span className="text-xs font-mono text-red-400">Liegt vor</span>
        ) : positive ? (
          <span className="text-xs font-mono text-emerald-400">Nicht feststellbar</span>
        ) : null}
      </div>
    </div>
  );
}

interface AktivaTabProps {
  aktiva?: AktivaAnalyse;
  forderungen: Forderungen;
  schuldner: Schuldner;
}

export function AktivaTab({ aktiva, forderungen, schuldner }: AktivaTabProps) {
  const positionen = aktiva?.positionen ?? [];

  const grouped = useMemo(() => {
    const map = new Map<AktivaKategorie, Aktivum[]>();
    for (const p of positionen) {
      const list = map.get(p.kategorie) || [];
      list.push(p);
      map.set(p.kategorie, list);
    }
    // Return in defined order, only categories that have items
    return KATEGORIE_ORDER
      .filter(k => map.has(k))
      .map(k => ({ kategorie: k, items: map.get(k)! }));
  }, [positionen]);

  const summeAktiva = getNum(aktiva?.summe_aktiva);
  const gesamtforderung = getNum(forderungen?.gesamtforderungen) ?? getNum(forderungen?.gesamtforderung);
  const massekosten = getNum(aktiva?.massekosten_schaetzung);

  const differenz = summeAktiva !== null && gesamtforderung !== null
    ? summeAktiva - gesamtforderung
    : null;

  const analyse = aktiva?.insolvenzanalyse;

  // Vergütungsschätzung nach InsVV (reine Berechnung, kein API-Call)
  const insvv = useMemo(() => {
    if (summeAktiva === null || summeAktiva <= 0) return null;
    return berechneInsVV(summeAktiva);
  }, [summeAktiva]);

  // Quotenberechnung (vereinfacht)
  // Freie Masse = Aktiva - Verfahrenskosten
  // Absonderungsberechtigte bekommen aus ihrem Sicherungsgegenstand, der Rest geht in die Masse
  // § 171 InsO: Kostenbeiträge 9% (Feststellung) + 5% (Verwertung) = 14% der gesicherten Verwertung
  const gesichertVal = getNum(forderungen?.gesicherte_forderungen);
  const ungesichertVal = getNum(forderungen?.ungesicherte_forderungen);
  const quote = useMemo(() => {
    if (summeAktiva === null || !insvv) return null;
    // NUR ungesicherte Forderungen verwenden — NICHT auf Gesamtforderung fallbacken,
    // da Gesamtforderung gesicherte Gläubiger enthält die aus ihrem Sicherungsgegenstand befriedigt werden
    if (ungesichertVal === null || ungesichertVal === undefined || ungesichertVal <= 0) return null;
    const ungesichert = ungesichertVal;
    // Kostenbeiträge § 171 InsO: ca. 14% der gesicherten Verwertungserlöse fließen in die Masse
    const kostenbeitraege = (gesichertVal ?? 0) * 0.14;
    const freieMasse = summeAktiva - insvv.gesamt + kostenbeitraege;
    if (freieMasse <= 0) return { prozent: 0, freieMasse: 0, verteilbar: 0 };
    const verteilbar = Math.max(0, freieMasse);
    const prozent = Math.min(100, Math.round((verteilbar / ungesichert) * 10000) / 100);
    return { prozent, freieMasse: verteilbar, verteilbar };
  }, [summeAktiva, insvv, gesichertVal, ungesichertVal, gesamtforderung]);

  // Empty state
  if (!aktiva || positionen.length === 0) {
    return (
      <EmptyState
        icon="▣"
        title="Keine Vermögenswerte in der Akte identifiziert."
        description="In der Akte wurden keine Vermögenswerte identifiziert."
      />
    );
  }

  const isJP = isJuristischePerson(schuldner);

  return (
    <>
      {/* ─── Summary Bar ─── */}
      <div className="bg-surface border border-border/60 rounded-lg shadow-card mb-2.5 p-3 px-4 flex flex-wrap items-center gap-3">
        <div className={`flex flex-col items-center px-3 py-1.5 rounded-md border ${summeAktiva && summeAktiva > 0 ? 'border-ie-green/30 bg-ie-green/5' : 'border-border bg-bg'}`}>
          <span className="text-[9px] text-text-dim font-sans">Summe Aktiva</span>
          <span className={`text-sm font-bold font-mono ${summeAktiva && summeAktiva > 0 ? 'text-ie-green' : 'text-text-muted'}`}>
            {summeAktiva !== null ? EUR.format(summeAktiva) : '—'}
          </span>
        </div>
        <div className="flex flex-col items-center px-3 py-1.5 rounded-md border border-ie-red/30 bg-ie-red/5">
          <span className="text-[9px] text-text-dim font-sans">Gesamtforderung</span>
          <span className="text-sm font-bold font-mono text-ie-red">
            {gesamtforderung !== null ? EUR.format(gesamtforderung) : '—'}
          </span>
        </div>
        <div className={`flex flex-col items-center px-3 py-1.5 rounded-md border ${differenz !== null && differenz >= 0 ? 'border-ie-green/30 bg-ie-green/5' : differenz !== null ? 'border-ie-red/30 bg-ie-red/5' : 'border-border bg-bg'}`}>
          <span className="text-[9px] text-text-dim font-sans">Differenz</span>
          <span className={`text-sm font-bold font-mono ${differenz !== null && differenz >= 0 ? 'text-ie-green' : differenz !== null ? 'text-ie-red' : 'text-text-muted'}`}>
            {differenz !== null ? EUR.format(differenz) : '—'}
          </span>
        </div>
        {summeAktiva !== null && gesamtforderung !== null && gesamtforderung > 0 && (() => {
          const deckung = (summeAktiva / gesamtforderung) * 100;
          const borderBg = deckung >= 100
            ? 'border-ie-green/30 bg-ie-green/5'
            : deckung >= 50
            ? 'border-ie-amber/30 bg-ie-amber/5'
            : 'border-ie-red/30 bg-ie-red/5';
          const textColor = deckung >= 100
            ? 'text-ie-green'
            : deckung >= 50
            ? 'text-ie-amber'
            : 'text-ie-red';
          return (
            <div className={`flex flex-col items-center px-3 py-1.5 rounded-md border ${borderBg}`}>
              <span className="text-[9px] text-text-dim font-sans">Deckung</span>
              <span className={`text-sm font-bold font-mono ${textColor}`}>
                {deckung.toFixed(1)}%
              </span>
            </div>
          );
        })()}
      </div>

      {/* ─── Asset Positions by Category ─── */}
      {grouped.map(({ kategorie, items }) => (
        <Section
          key={kategorie}
          title={KATEGORIE_LABELS[kategorie]}
          icon={KATEGORIE_ICONS[kategorie]}
          count={items.length}
        >
          {items.map((item, i) => {
            const globalIdx = positionen.indexOf(item);
            return (
              <div key={i} className="mb-1 last:mb-0">
                <DataField label="Beschreibung" field={item.beschreibung} fieldPath={`aktiva.positionen[${globalIdx}].beschreibung`} />
                <DataField label="Geschätzter Wert" field={item.geschaetzter_wert} isCurrency fieldPath={`aktiva.positionen[${globalIdx}].geschaetzter_wert`} />
              </div>
            );
          })}
        </Section>
      ))}

      {/* ─── Gegenüberstellung ─── */}
      <Section title="Gegenüberstellung" icon="⊞">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-1.5 text-[11px] text-text-dim font-sans font-normal">Position</th>
              <th className="text-right py-1.5 text-[11px] text-text-dim font-sans font-normal">Betrag</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="py-1.5 text-text">Summe Aktiva</td>
              <td className="py-1.5 text-right text-text">{summeAktiva !== null ? EUR.format(summeAktiva) : '—'}</td>
            </tr>
            <tr className="border-b border-border">
              <td className="py-1.5 text-text">Gesamtforderung</td>
              <td className="py-1.5 text-right text-ie-red">{gesamtforderung !== null ? EUR.format(gesamtforderung) : '—'}</td>
            </tr>
            <tr className="border-b border-border">
              <td className="py-1.5 text-text">Massekosten (KI-Schätzung)</td>
              <td className="py-1.5 text-right text-text-muted">{massekosten !== null ? EUR.format(massekosten) : '—'}</td>
            </tr>
            {insvv && (
              <>
                <tr className="border-b border-border/50 bg-bg/30">
                  <td className="py-1 pl-4 text-[10px] text-text-dim">Verwaltervergütung § 2 InsVV</td>
                  <td className="py-1 text-right text-[10px] text-text-muted">{EUR.format(insvv.verguetung)}</td>
                </tr>
                <tr className="border-b border-border/50 bg-bg/30">
                  <td className="py-1 pl-4 text-[10px] text-text-dim">Gerichtskosten (GKG)</td>
                  <td className="py-1 text-right text-[10px] text-text-muted">{EUR.format(insvv.gerichtskosten)}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="py-1.5 text-text font-semibold">Verfahrenskosten § 54 InsO (berechnet)</td>
                  <td className="py-1.5 text-right text-text font-semibold">{EUR.format(insvv.gesamt)}</td>
                </tr>
              </>
            )}
            <tr className="border-t-2 border-accent">
              <td className="py-2 font-bold text-text">Differenz</td>
              <td className={`py-2 text-right font-bold ${differenz !== null && differenz >= 0 ? 'text-ie-green' : 'text-ie-red'}`}>
                {differenz !== null ? EUR.format(differenz) : '—'}
              </td>
            </tr>
            {insvv && summeAktiva !== null && (
              <tr className="border-t border-border/50">
                <td className="py-1.5 text-[10px] text-text-dim">Nach Verfahrenskosten verbleibend</td>
                <td className={`py-1.5 text-right text-[10px] font-bold ${summeAktiva - insvv.gesamt >= 0 ? 'text-ie-green' : 'text-ie-red'}`}>
                  {EUR.format(summeAktiva - insvv.gesamt)}
                </td>
              </tr>
            )}
            {quote && (
              <tr className="border-t-2 border-ie-blue/50 bg-ie-blue/5">
                <td className="py-2 text-xs text-text">
                  <span className="font-bold">Voraussichtliche Quote</span>
                  <span className="text-[9px] text-text-dim ml-2">(§ 38 Insolvenzforderungen)</span>
                </td>
                <td className="py-2 text-right">
                  <span className={`text-sm font-bold font-mono ${quote.prozent > 0 ? 'text-ie-blue' : 'text-ie-red'}`}>
                    {quote.prozent.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {insvv && (
          <div className="mt-2 p-2 bg-bg border border-border rounded-md text-[8px] text-text-dim leading-relaxed">
            <span className="font-bold">Berechnungsgrundlagen:</span> Verwaltervergütung nach § 2 Abs. 1 InsVV (Regelvergütung ohne Zu-/Abschläge nach § 3 InsVV). Gerichtskosten: GKG KV Nr. 2310 (1,5 Gebühren). Quote nur berechenbar wenn ungesicherte Forderungen separat erfasst. Formel: (Aktiva - Verfahrenskosten + Kostenbeiträge § 171 InsO [14%]) / Ungesicherte Insolvenzforderungen § 38. Alle Werte sind vorläufige Schätzungen.
          </div>
        )}
      </Section>

      {/* ─── Insolvenzanalyse ─── */}
      <Section title="Insolvenzanalyse" icon="◈" defaultOpen>
        {analyse?.zahlungsunfaehigkeit_17 ? (
          <div className="space-y-3">
            <BewertungRow label="Zahlungsunfähigkeit § 17 InsO" bewertung={analyse.zahlungsunfaehigkeit_17} />
            {analyse.drohende_zahlungsunfaehigkeit_18 && <BewertungRow label="Drohende Zahlungsunfähigkeit § 18 InsO" bewertung={analyse.drohende_zahlungsunfaehigkeit_18} />}
            {analyse.ueberschuldung_19 && <BewertungRow label="Überschuldung § 19 InsO" bewertung={analyse.ueberschuldung_19} />}
            {analyse.massekostendeckung_26 && <BewertungRow label="Massekostendeckung § 26 InsO" bewertung={analyse.massekostendeckung_26} />}

            {analyse.gesamtbewertung && (
              <div className="mt-2 p-2.5 bg-bg border border-accent/30 rounded-md">
                <span className="text-[9px] text-text-dim font-sans block mb-1">Gesamtbewertung</span>
                <span className="text-[11px] text-text font-mono leading-relaxed">{analyse.gesamtbewertung}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <FallbackRow label="Zahlungsunfähigkeit § 17 InsO" result={summeAktiva !== null && gesamtforderung !== null ? summeAktiva < gesamtforderung : null} />
            <FallbackRow label="Überschuldung § 19 InsO" result={isJP && summeAktiva !== null && gesamtforderung !== null ? summeAktiva < gesamtforderung : null} hidden={!isJP} />
            <FallbackRow label="Massekostendeckung § 26 InsO" result={summeAktiva !== null && massekosten !== null ? summeAktiva >= massekosten : null} invert />
          </div>
        )}

        {/* Disclaimer */}
        <div className="mt-3 p-2 bg-bg border border-border rounded-md text-[9px] text-text-muted italic leading-relaxed">
          Diese automatische Analyse ersetzt keine rechtliche Prüfung. Alle Werte müssen manuell verifiziert werden.
        </div>
      </Section>
    </>
  );
}
