import { useMemo } from 'react';
import { DataField } from '../DataField';
import { Section } from '../Section';
import { StatsBar } from '../StatsBar';
import { SourcedItem } from '../SourcedItem';
import type { ExtractionResult } from '../../../types/extraction';

const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

interface Warnung {
  typ: 'fehler' | 'warnung' | 'info';
  text: string;
}

function crossValidate(r: ExtractionResult): Warnung[] {
  const warnungen: Warnung[] = [];

  // 1. Gesamtforderungen vs Summe Einzelforderungen
  const einzelforderungen = r.forderungen?.einzelforderungen ?? [];
  const gesamtExtrahiert = r.forderungen?.gesamtforderungen?.wert;
  if (einzelforderungen.length > 0 && gesamtExtrahiert != null) {
    const summeBerechnet = einzelforderungen.reduce((s, f) => s + (f.betrag?.wert ?? 0), 0);
    if (summeBerechnet > 0 && Math.abs(summeBerechnet - gesamtExtrahiert) > 1) {
      warnungen.push({
        typ: 'warnung',
        text: `Gesamtforderungen (${EUR.format(gesamtExtrahiert)}) ≠ Summe Einzelforderungen (${EUR.format(summeBerechnet)}) — Differenz: ${EUR.format(Math.abs(gesamtExtrahiert - summeBerechnet))}`,
      });
    }
  }

  // 2. Summe Aktiva vs Summe Positionen
  const positionen = r.aktiva?.positionen ?? [];
  const summeAktivaExtrahiert = r.aktiva?.summe_aktiva?.wert;
  if (positionen.length > 0 && summeAktivaExtrahiert != null) {
    const summePositionen = positionen.reduce((s, p) => s + (p.geschaetzter_wert?.wert ?? 0), 0);
    if (summePositionen > 0 && Math.abs(summePositionen - summeAktivaExtrahiert) > 1) {
      warnungen.push({
        typ: 'warnung',
        text: `Summe Aktiva (${EUR.format(summeAktivaExtrahiert)}) ≠ Summe Positionen (${EUR.format(summePositionen)}) — Differenz: ${EUR.format(Math.abs(summeAktivaExtrahiert - summePositionen))}`,
      });
    }
  }

  // 3. Pfändungsberechnung Konsistenz
  const pf = r.schuldner?.pfaendungsberechnung;
  const besch = r.schuldner?.beschaeftigung;
  if (pf?.nettoeinkommen?.wert != null && besch?.nettoeinkommen?.wert != null) {
    if (Math.abs(pf.nettoeinkommen.wert - besch.nettoeinkommen.wert) > 1) {
      warnungen.push({
        typ: 'warnung',
        text: `Nettoeinkommen in Pfändungsberechnung (${EUR.format(pf.nettoeinkommen.wert)}) ≠ Beschäftigung (${EUR.format(besch.nettoeinkommen.wert)})`,
      });
    }
  }

  // 4. Familienstand vs Ehegatte
  const familienstand = String(r.schuldner?.familienstand?.wert ?? '').toLowerCase();
  // Check for ehegatte object presence (not just name.wert — spouse may have geburtsdatum/gueterstand without name)
  const ehegatteObj = r.schuldner?.ehegatte;
  const hatEhegatte = ehegatteObj != null && (ehegatteObj.name?.wert || ehegatteObj.geburtsdatum?.wert || ehegatteObj.gueterstand !== 'unbekannt');
  const ehegatteName = ehegatteObj?.name?.wert || 'Name unbekannt';
  if (familienstand.includes('ledig') && hatEhegatte) {
    warnungen.push({ typ: 'warnung', text: `Familienstand "ledig" aber Ehegatte "${ehegatteName}" gefunden` });
  }
  if ((familienstand.includes('verheiratet') || familienstand.includes('verpartnert')) && !hatEhegatte) {
    warnungen.push({ typ: 'info', text: 'Familienstand verheiratet/verpartnert aber kein Ehegatte in der Akte gefunden — ggf. nachermitteln' });
  }

  // 5. Anfechtungspotenzial vs Masse
  const anfechtPotenzial = r.anfechtung?.gesamtpotenzial?.wert;
  if (anfechtPotenzial && anfechtPotenzial > 0 && summeAktivaExtrahiert != null) {
    const quotient = anfechtPotenzial / Math.max(summeAktivaExtrahiert, 1);
    if (quotient > 0.5) {
      warnungen.push({
        typ: 'info',
        text: `Anfechtungspotenzial (${EUR.format(anfechtPotenzial)}) übersteigt 50% der Aktiva — kann Masse erheblich erhöhen`,
      });
    }
  }

  // 6. Keine Forderungen aber Verfahren eröffnet
  if (einzelforderungen.length === 0 && gesamtExtrahiert == null) {
    warnungen.push({ typ: 'info', text: 'Keine Forderungen in der Akte identifiziert — Gläubigerverzeichnis prüfen' });
  }

  // 7. Betriebsstätte = Privatanschrift (häufiger Fehler bei Einzelunternehmern)
  const betrStaette = String(r.schuldner?.betriebsstaette_adresse?.wert ?? '').trim();
  const privat = String(r.schuldner?.aktuelle_adresse?.wert ?? '').trim();
  if (betrStaette && privat && betrStaette.includes(privat.split(',')[0] || '___')) {
    // Check if risiken mention an address discrepancy
    const risikenText = (r.risiken_hinweise || []).map(h => String(h.wert ?? '')).join(' ').toLowerCase();
    if (risikenText.includes('adress') || risikenText.includes('niederstr') || risikenText.includes('betriebsstätte')) {
      warnungen.push({
        typ: 'warnung',
        text: `Betriebsstätte (${betrStaette}) = Privatanschrift, aber Risiken erwähnen Adressdiskrepanz — Betriebsstätte-Adresse manuell prüfen (ggf. andere Adresse im Insolvenzantrag)`,
      });
    }
  }

  return warnungen;
}

interface OverviewTabProps {
  result: ExtractionResult;
  stats: { found: number; missing: number; total: number };
  lettersReady: number;
  lettersNA: number;
  lettersOpen: number;
}

export function OverviewTab({ result: r, stats, lettersReady, lettersNA, lettersOpen }: OverviewTabProps) {
  const warnungen = useMemo(() => crossValidate(r), [r]);

  return (
    <>
      <StatsBar
        found={stats.found}
        missing={stats.missing}
        total={stats.total}
        lettersReady={lettersReady}
        lettersNA={lettersNA}
        lettersOpen={lettersOpen}
      />

      {/* ─── Cross-Validierung ─── */}
      {warnungen.length > 0 && (
        <div className="bg-surface border border-amber-400/30 rounded-sm mb-2.5 p-3 px-4">
          <div className="text-[10px] text-amber-400 font-bold font-mono mb-2 uppercase tracking-wide">
            Konsistenzprüfung ({warnungen.length})
          </div>
          <div className="space-y-1.5">
            {warnungen.map((w, i) => (
              <div key={i} className="flex items-start gap-2 text-[10px] font-mono">
                <span className={`flex-shrink-0 mt-0.5 ${w.typ === 'fehler' ? 'text-red-400' : w.typ === 'warnung' ? 'text-amber-400' : 'text-ie-blue'}`}>
                  {w.typ === 'fehler' ? '✗' : w.typ === 'warnung' ? '△' : 'ℹ'}
                </span>
                <span className="text-text-muted">{w.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {r.zusammenfassung?.length > 0 && (
        <Section title="Zusammenfassung" icon="▤">
          {r.zusammenfassung.map((item, i) => (
            <SourcedItem key={i} item={item} />
          ))}
        </Section>
      )}

      <Section title="Verfahrensdaten" icon="⚖">
        <DataField label="Aktenzeichen" field={r.verfahrensdaten?.aktenzeichen} />
        <DataField label="Gericht" field={r.verfahrensdaten?.gericht} />
        <DataField label="Richter" field={r.verfahrensdaten?.richter} />
        <DataField label="Antragsdatum" field={r.verfahrensdaten?.antragsdatum} />
        <DataField label="Beschlussdatum" field={r.verfahrensdaten?.beschlussdatum} />
        <DataField label="Antragsart" field={r.verfahrensdaten?.antragsart} />
        <DataField label="Eröffnungsgrund" field={r.verfahrensdaten?.eroeffnungsgrund} />
        <DataField label="Zustellung Schuldner" field={r.verfahrensdaten?.zustellungsdatum_schuldner} />
        <DataField label="Verfahrensstadium" field={r.verfahrensdaten?.verfahrensstadium} />
        <DataField label="Verfahrensart" field={r.verfahrensdaten?.verfahrensart} />
      </Section>

      {r.fristen?.length > 0 && (
        <Section title="Fristen" icon="⏱" count={r.fristen.length}>
          {r.fristen.map((f, i) => (
            <div key={i} className="flex items-center py-1.5 border-b border-border gap-2.5">
              <span className="flex-1 text-[11px] text-text font-sans">{f.bezeichnung}</span>
              <span className="text-[11px] text-ie-amber font-semibold">{f.datum}</span>
              {f.quelle && <span className="text-[9px] text-text-muted">({f.quelle})</span>}
            </div>
          ))}
        </Section>
      )}

      {r.risiken_hinweise?.length > 0 && (
        <Section title="Risiken & Hinweise" icon="⚡" count={r.risiken_hinweise.length}>
          {r.risiken_hinweise.map((item, i) => (
            <SourcedItem key={i} item={item} variant="warning" />
          ))}
        </Section>
      )}
    </>
  );
}
