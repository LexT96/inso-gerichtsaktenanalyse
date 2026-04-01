import { DataField } from '../DataField';
import { Section } from '../Section';
import type { Schuldner, Antragsteller, Gueterstand } from '../../../types/extraction';

const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

const GUETERSTAND_LABELS: Record<Gueterstand, string> = {
  zugewinngemeinschaft: 'Zugewinngemeinschaft',
  guetertrennung: 'Guetertrennung',
  guetergemeinschaft: 'Guetergemeinschaft',
  unbekannt: 'Unbekannt',
};

const GUETERSTAND_STYLES: Record<Gueterstand, string> = {
  zugewinngemeinschaft: 'bg-ie-blue/10 text-ie-blue border-ie-blue/30',
  guetertrennung: 'bg-ie-green/10 text-ie-green border-ie-green/30',
  guetergemeinschaft: 'bg-amber-400/10 text-amber-400 border-amber-400/30',
  unbekannt: 'bg-bg text-text-muted border-border',
};

/** Detect if Schuldner is a juristische Person or Personengesellschaft (not a natural person) */
function isJuristischePersonOderGesellschaft(s: Schuldner): boolean {
  const rf = String(s?.rechtsform?.wert ?? '').toLowerCase();
  if (!rf) return false;
  return /gmbh|ug\b|ag\b|se\b|kg\b|ohg|gbr|e\.?\s?v|partg|stiftung|verein|genossenschaft|kgaa/i.test(rf)
    || rf.includes('juristische') || rf.includes('gesellschaft');
}

interface BeteiligteTabProps {
  schuldner: Schuldner;
  antragsteller: Antragsteller;
}

export function BeteiligteTab({ schuldner: s, antragsteller: a }: BeteiligteTabProps) {
  const isEntity = isJuristischePersonOderGesellschaft(s);

  return (
    <>
      {isEntity ? (
        /* ─── Juristische Person / Gesellschaft ─── */
        <Section title="Schuldner — Unternehmen" icon="●">
          <DataField label="Firma" field={s?.firma} fieldPath="schuldner.firma" />
          <DataField label="Rechtsform" field={s?.rechtsform} fieldPath="schuldner.rechtsform" />
          <DataField label="Name (Vertretung)" field={s?.name} fieldPath="schuldner.name" />
          <DataField label="Handelsregister-Nr." field={s?.handelsregisternummer} fieldPath="schuldner.handelsregisternummer" />
          <DataField label="Betriebsstätte" field={s?.betriebsstaette_adresse} fieldPath="schuldner.betriebsstaette_adresse" />
        </Section>
      ) : (
        /* ─── Natürliche Person ─── */
        <>
          <Section title="Schuldner — Persönliche Daten" icon="●">
            <DataField label="Name" field={s?.name} fieldPath="schuldner.name" />
            <DataField label="Vorname" field={s?.vorname} fieldPath="schuldner.vorname" />
            <DataField label="Geburtsdatum" field={s?.geburtsdatum} fieldPath="schuldner.geburtsdatum" />
            <DataField label="Geburtsort" field={s?.geburtsort} fieldPath="schuldner.geburtsort" />
            <DataField label="Geburtsland" field={s?.geburtsland} fieldPath="schuldner.geburtsland" />
            <DataField label="Staatsangehörigkeit" field={s?.staatsangehoerigkeit} fieldPath="schuldner.staatsangehoerigkeit" />
            <DataField label="Familienstand" field={s?.familienstand} fieldPath="schuldner.familienstand" />
            <DataField label="Geschlecht" field={s?.geschlecht} fieldPath="schuldner.geschlecht" />
          </Section>
          <Section title="Schuldner — Adresse & Betrieb" icon="▫">
            <DataField label="Aktuelle Adresse" field={s?.aktuelle_adresse} fieldPath="schuldner.aktuelle_adresse" />
            {(s?.firma?.wert || s?.rechtsform?.wert || s?.handelsregisternummer?.wert) && (
              <>
                <DataField label="Firma" field={s?.firma} fieldPath="schuldner.firma" />
                <DataField label="Rechtsform" field={s?.rechtsform} fieldPath="schuldner.rechtsform" />
                <DataField label="Betriebsstätte" field={s?.betriebsstaette_adresse} fieldPath="schuldner.betriebsstaette_adresse" />
                <DataField label="Handelsregister-Nr." field={s?.handelsregisternummer} fieldPath="schuldner.handelsregisternummer" />
              </>
            )}
          </Section>
        </>
      )}
      {s?.fruehere_adressen?.length > 0 && (
        <Section title="Schuldner — Frühere Adressen" icon="◌" count={s.fruehere_adressen.length} defaultOpen={false}>
          {s.fruehere_adressen.map((addr, i) => {
            if (typeof addr === 'string') {
              return <div key={i} className="py-1.5 border-b border-border text-[11px] text-text-dim">{addr}</div>;
            }
            if (typeof addr === 'object' && addr && 'wert' in addr) {
              return <DataField key={i} label={`Adresse ${i + 1}`} field={addr} fieldPath={`schuldner.fruehere_adressen[${i}]`} />;
            }
            if (typeof addr === 'object' && addr && 'adresse' in addr) {
              const a = addr as { adresse?: string; einzug?: string; auszug?: string; zeitraum?: string; quelle?: string };
              const period = a.zeitraum || (a.einzug && a.auszug ? `${a.einzug} – ${a.auszug}` : '');
              return (
                <DataField
                  key={i}
                  label={period || `Adresse ${i + 1}`}
                  field={{ wert: a.adresse ?? '', quelle: a.quelle ?? '' }}
                  fieldPath={`schuldner.fruehere_adressen[${i}]`}
                />
              );
            }
            return <div key={i} className="py-1.5 border-b border-border text-[11px] text-text-dim">{JSON.stringify(addr)}</div>;
          })}
        </Section>
      )}
      {!isEntity && s?.kinder?.length > 0 && (
        <Section title="Schuldner — Kinder" icon="○" count={s.kinder.length} defaultOpen={false}>
          {s.kinder.map((kind, i) => {
            if (typeof kind === 'string') {
              return <div key={i} className="py-1.5 border-b border-border text-[11px] text-text-dim">{kind}</div>;
            }
            if (typeof kind === 'object' && kind && 'wert' in kind) {
              return <DataField key={i} label={`Kind ${i + 1}`} field={kind} fieldPath={`schuldner.kinder[${i}]`} />;
            }
            if (typeof kind === 'object' && kind && 'name' in kind) {
              const k = kind as { name?: string; geburtsdatum?: string; geschlecht?: string; anschrift?: string; quelle?: string };
              const details = [k.geburtsdatum, k.geschlecht].filter(Boolean).join(', ');
              const displayValue = details ? `${k.name} (${details})` : (k.name || '');
              return (
                <DataField
                  key={i}
                  label={`Kind ${i + 1}`}
                  field={{ wert: displayValue, quelle: k.quelle ?? '' }}
                  fieldPath={`schuldner.kinder[${i}]`}
                />
              );
            }
            return <div key={i} className="py-1.5 border-b border-border text-[11px] text-text-dim">{JSON.stringify(kind)}</div>;
          })}
        </Section>
      )}
      {/* ─── Ehegatte / Lebenspartner (nur natürliche Personen) ─── */}
      {!isEntity && s?.ehegatte && (s.ehegatte.name?.wert || s.ehegatte.geburtsdatum?.wert || s.ehegatte.gemeinsames_eigentum?.wert) && (
        <Section title="Ehegatte / Lebenspartner" icon="◑">
          <DataField label="Name" field={s.ehegatte.name} fieldPath="schuldner.ehegatte.name" />
          <DataField label="Geburtsdatum" field={s.ehegatte.geburtsdatum} fieldPath="schuldner.ehegatte.geburtsdatum" />
          <div className="flex items-start py-1.5 border-b border-border gap-2">
            <span className="flex-shrink-0 w-[180px] text-[11px] text-text-dim pt-0.5">Güterstand</span>
            <div className="flex-1 min-w-0">
              <span
                className={`inline-block px-2 py-0.5 rounded-md text-[9px] font-bold tracking-wide border font-mono ${GUETERSTAND_STYLES[s.ehegatte.gueterstand] || GUETERSTAND_STYLES.unbekannt}`}
              >
                {GUETERSTAND_LABELS[s.ehegatte.gueterstand] || 'Unbekannt'}
              </span>
            </div>
          </div>
          {s.ehegatte.gemeinsames_eigentum?.wert && (
            <DataField label="Gemeinsames Eigentum" field={s.ehegatte.gemeinsames_eigentum} fieldPath="schuldner.ehegatte.gemeinsames_eigentum" />
          )}
        </Section>
      )}

      {/* ─── Beschäftigung (nur natürliche Personen, nur wenn Daten vorhanden) ─── */}
      {!isEntity && s?.beschaeftigung && (s.beschaeftigung.arbeitgeber?.wert || s.beschaeftigung.nettoeinkommen?.wert || s.beschaeftigung.art?.wert) && (
        <Section title="Beschäftigung" icon="◧">
          <DataField label="Arbeitgeber" field={s.beschaeftigung.arbeitgeber} fieldPath="schuldner.beschaeftigung.arbeitgeber" />
          <DataField label="Arbeitgeber Adresse" field={s.beschaeftigung.arbeitgeber_adresse} fieldPath="schuldner.beschaeftigung.arbeitgeber_adresse" />
          <DataField label="Nettoeinkommen" field={s.beschaeftigung.nettoeinkommen} isCurrency fieldPath="schuldner.beschaeftigung.nettoeinkommen" />
          <DataField label="Beschäftigt seit" field={s.beschaeftigung.beschaeftigt_seit} fieldPath="schuldner.beschaeftigung.beschaeftigt_seit" />
          <DataField label="Art" field={s.beschaeftigung.art} fieldPath="schuldner.beschaeftigung.art" />
        </Section>
      )}

      {/* ─── Pfändungsberechnung § 850c ZPO (nur natürliche Personen, nur wenn Einkommen vorhanden) ─── */}
      {!isEntity && s?.pfaendungsberechnung && s.pfaendungsberechnung.nettoeinkommen?.wert != null && (
        <Section title="Pfaendungsberechnung § 850c ZPO" icon="▥">
          <div className="flex flex-wrap gap-3 py-2">
            <div className="flex flex-col items-center px-3 py-1.5 rounded-md border border-border/60 bg-bg">
              <span className="text-[9px] text-text-dim font-sans">Nettoeinkommen</span>
              <span className="text-sm font-bold font-mono text-text">
                {s.pfaendungsberechnung.nettoeinkommen?.wert != null
                  ? EUR.format(s.pfaendungsberechnung.nettoeinkommen.wert)
                  : '\u2014'}
              </span>
            </div>
            <div className="flex flex-col items-center px-3 py-1.5 rounded-md border border-border/60 bg-bg">
              <span className="text-[9px] text-text-dim font-sans">Unterhaltspflichten</span>
              <span className="text-sm font-bold font-mono text-text">
                {s.pfaendungsberechnung.unterhaltspflichten?.wert != null
                  ? String(s.pfaendungsberechnung.unterhaltspflichten.wert)
                  : '\u2014'}
              </span>
            </div>
            <div className="flex flex-col items-center px-3 py-1.5 rounded-md border border-accent/30 bg-accent/5">
              <span className="text-[9px] text-text-dim font-sans">Pfaendbarer Betrag</span>
              <span className="text-sm font-bold font-mono text-accent">
                {s.pfaendungsberechnung.pfaendbarer_betrag?.wert != null
                  ? EUR.format(s.pfaendungsberechnung.pfaendbarer_betrag.wert)
                  : '\u2014'}
              </span>
            </div>
          </div>
        </Section>
      )}

      <Section title="Antragsteller" icon="◆">
        <DataField label="Name" field={a?.name} fieldPath="antragsteller.name" />
        <DataField label="Adresse" field={a?.adresse} fieldPath="antragsteller.adresse" />
        <DataField label="Ansprechpartner" field={a?.ansprechpartner} fieldPath="antragsteller.ansprechpartner" />
        <DataField label="Telefon" field={a?.telefon} fieldPath="antragsteller.telefon" />
        <DataField label="Fax" field={a?.fax} fieldPath="antragsteller.fax" />
        <DataField label="E-Mail" field={a?.email} fieldPath="antragsteller.email" />
        <DataField label="Betriebsnummer" field={a?.betriebsnummer} fieldPath="antragsteller.betriebsnummer" />
        <DataField label="IBAN" field={a?.bankverbindung_iban} fieldPath="antragsteller.bankverbindung_iban" />
        <DataField label="BIC" field={a?.bankverbindung_bic} fieldPath="antragsteller.bankverbindung_bic" />
      </Section>
    </>
  );
}
