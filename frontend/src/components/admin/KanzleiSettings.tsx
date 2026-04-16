import { useState, useEffect } from 'react';
import { apiClient } from '../../api/client';

// ─── Types ───

interface KanzleiMeta {
  name: string;
  kurz: string;
  website: string;
  partnerschaftsregister: string;
}

interface Standort {
  adresse: string;
  telefon: string;
}

interface Partner {
  name: string;
  titel: string;
  kategorie: string;
}

interface KanzleiData {
  kanzlei: KanzleiMeta;
  standorte: Record<string, Standort>;
  insolvenzgerichte: Record<string, { name: string; adresse: string; plz_ort: string }>;
  partner: Partner[];
}

type SaveState = 'idle' | 'saving' | 'success' | 'error';

const KATEGORIEN = ['PARTNER', 'ANGESTELLTE RECHTSANWÄLTE', 'OF COUNSEL'] as const;

// ─── Sub-components ───

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9px] text-text-dim uppercase tracking-[2px] font-mono mb-3">
      {children}
    </div>
  );
}

function TextInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[9px] text-text-dim uppercase tracking-[2px] font-mono">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-bg border border-border rounded-sm text-[11px] px-2 py-1.5 font-mono text-text focus:outline-none focus:border-accent transition-colors"
      />
    </div>
  );
}

// ─── Main Component ───

export function KanzleiSettings() {
  const [data, setData] = useState<KanzleiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    apiClient.get('/kanzlei')
      .then(res => { setData(res.data as KanzleiData); })
      .catch(err => {
        const msg = err?.response?.data?.error || err?.message || 'Ladefehler';
        setLoadError(msg);
      })
      .finally(() => setLoading(false));
  }, []);

  // ─── Kanzlei meta handlers ───

  function setMeta(field: keyof KanzleiMeta, value: string) {
    if (!data) return;
    setData({ ...data, kanzlei: { ...data.kanzlei, [field]: value } });
  }

  // ─── Partner handlers ───

  function setPartnerField(idx: number, field: keyof Partner, value: string) {
    if (!data) return;
    const updated = data.partner.map((p, i) => i === idx ? { ...p, [field]: value } : p);
    setData({ ...data, partner: updated });
  }

  function addPartner() {
    if (!data) return;
    setData({ ...data, partner: [...data.partner, { name: '', titel: '', kategorie: 'PARTNER' }] });
  }

  function removePartner(idx: number) {
    if (!data) return;
    setData({ ...data, partner: data.partner.filter((_, i) => i !== idx) });
  }

  // ─── Standorte handlers ───

  function setStandortField(key: string, field: keyof Standort, value: string) {
    if (!data) return;
    setData({
      ...data,
      standorte: { ...data.standorte, [key]: { ...data.standorte[key], [field]: value } },
    });
  }

  function setStandortKey(oldKey: string, newKey: string) {
    if (!data || newKey === oldKey) return;
    const entries = Object.entries(data.standorte);
    const reordered = entries.map(([k, v]) => k === oldKey ? [newKey, v] as [string, Standort] : [k, v] as [string, Standort]);
    setData({ ...data, standorte: Object.fromEntries(reordered) });
  }

  function addStandort() {
    if (!data) return;
    // Find a unique default key
    let key = 'Neu';
    let n = 1;
    while (key in data.standorte) { key = `Neu ${n++}`; }
    setData({ ...data, standorte: { ...data.standorte, [key]: { adresse: '', telefon: '' } } });
  }

  function removeStandort(key: string) {
    if (!data) return;
    const updated = { ...data.standorte };
    delete updated[key];
    setData({ ...data, standorte: updated });
  }

  // ─── Save ───

  async function handleSave() {
    if (!data) return;
    setSaveState('saving');
    setSaveMessage('');
    try {
      const res = await apiClient.put('/kanzlei', data);
      const body = res.data as { ok: boolean; syncOutput?: string; message?: string };
      setSaveState('success');
      const extra = body.syncOutput ? ` — Sync: ${body.syncOutput}` : (body.message ? ` — ${body.message}` : '');
      setSaveMessage(`Gespeichert.${extra}`);
    } catch (err: unknown) {
      setSaveState('error');
      const axiosErr = err as { response?: { data?: { error?: string } }; message?: string };
      setSaveMessage(axiosErr?.response?.data?.error || axiosErr?.message || 'Speichern fehlgeschlagen');
    }
  }

  // ─── Render ───

  const labelClass = 'text-[9px] text-text-dim uppercase tracking-[2px] font-mono';
  const cardClass = 'bg-surface border border-border/60 rounded-lg p-4 shadow-card';
  const btnBase = 'px-3 py-1.5 border rounded-sm text-[10px] cursor-pointer font-mono transition-colors';
  const btnPrimary = `${btnBase} bg-accent/10 border-accent/40 text-accent hover:bg-accent/20`;
  const btnGhost = `${btnBase} bg-transparent border-border text-text-muted hover:border-accent hover:text-accent`;
  const btnDanger = `${btnBase} bg-transparent border-ie-red-border/40 text-ie-red hover:border-ie-red hover:bg-ie-red-bg transition-colors`;

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin-fast" />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className={`${cardClass} text-ie-red text-[11px]`}>
        Fehler: {loadError || 'Keine Daten'}
      </div>
    );
  }

  const standortEntries = Object.entries(data.standorte);

  return (
    <div className="space-y-6">

      {/* ─── Kanzleidaten ─── */}
      <div className={cardClass}>
        <SectionLabel>Kanzleidaten</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="Name"
            value={data.kanzlei.name}
            onChange={v => setMeta('name', v)}
            placeholder="Vollständiger Kanzleiname"
          />
          <TextInput
            label="Kurzbezeichnung"
            value={data.kanzlei.kurz}
            onChange={v => setMeta('kurz', v)}
            placeholder="Kurzname"
          />
          <TextInput
            label="Website"
            value={data.kanzlei.website}
            onChange={v => setMeta('website', v)}
            placeholder="www.beispiel.de"
          />
          <TextInput
            label="Partnerschaftsregister"
            value={data.kanzlei.partnerschaftsregister}
            onChange={v => setMeta('partnerschaftsregister', v)}
            placeholder="Amtsgericht … – PR …"
          />
        </div>
      </div>

      {/* ─── Partner & Anwälte ─── */}
      <div className={cardClass}>
        <SectionLabel>Partner &amp; Anwälte ({data.partner.length})</SectionLabel>
        <div className="space-y-2">
          {data.partner.map((p, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_1.5fr_180px_28px] gap-2 items-start bg-bg/50 border border-border/40 rounded p-2">
              {/* Name */}
              <div className="flex flex-col gap-1">
                <span className={labelClass}>Name</span>
                <input
                  type="text"
                  value={p.name}
                  onChange={e => setPartnerField(idx, 'name', e.target.value)}
                  placeholder="Vollständiger Name"
                  className="bg-bg border border-border rounded-sm text-[11px] px-2 py-1 font-mono text-text focus:outline-none focus:border-accent transition-colors"
                />
              </div>
              {/* Titel */}
              <div className="flex flex-col gap-1">
                <span className={labelClass}>Titel / Fachgebiete</span>
                <textarea
                  value={p.titel}
                  onChange={e => setPartnerField(idx, 'titel', e.target.value)}
                  placeholder="Fachanwalt für …"
                  rows={2}
                  className="bg-bg border border-border rounded-sm text-[11px] px-2 py-1 font-mono text-text focus:outline-none focus:border-accent transition-colors resize-y min-h-[44px]"
                />
              </div>
              {/* Kategorie */}
              <div className="flex flex-col gap-1">
                <span className={labelClass}>Kategorie</span>
                <select
                  value={p.kategorie}
                  onChange={e => setPartnerField(idx, 'kategorie', e.target.value)}
                  className="bg-bg border border-border rounded-sm text-[11px] px-2 py-1.5 font-mono text-text focus:outline-none focus:border-accent transition-colors"
                >
                  {KATEGORIEN.map(k => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </div>
              {/* Delete */}
              <div className="flex items-start pt-5">
                <button
                  onClick={() => removePartner(idx)}
                  title="Eintrag löschen"
                  className={`${btnDanger} px-1.5 py-1 text-[10px]`}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
        <button onClick={addPartner} className={`${btnGhost} mt-3 text-[10px]`}>
          + Hinzufügen
        </button>
      </div>

      {/* ─── Standorte ─── */}
      <div className={cardClass}>
        <SectionLabel>Standorte ({standortEntries.length})</SectionLabel>
        <div className="space-y-2">
          {standortEntries.map(([key, standort]) => (
            <div key={key} className="grid grid-cols-[160px_1fr_1fr_28px] gap-2 items-start bg-bg/50 border border-border/40 rounded p-2">
              {/* Stadt (key) */}
              <div className="flex flex-col gap-1">
                <span className={labelClass}>Stadt</span>
                <input
                  type="text"
                  value={key}
                  onChange={e => setStandortKey(key, e.target.value)}
                  className="bg-bg border border-border rounded-sm text-[11px] px-2 py-1 font-mono text-text focus:outline-none focus:border-accent transition-colors"
                />
              </div>
              {/* Adresse */}
              <div className="flex flex-col gap-1">
                <span className={labelClass}>Adresse</span>
                <input
                  type="text"
                  value={standort.adresse}
                  onChange={e => setStandortField(key, 'adresse', e.target.value)}
                  placeholder="Straße Nr., PLZ Ort"
                  className="bg-bg border border-border rounded-sm text-[11px] px-2 py-1 font-mono text-text focus:outline-none focus:border-accent transition-colors"
                />
              </div>
              {/* Telefon */}
              <div className="flex flex-col gap-1">
                <span className={labelClass}>Telefon</span>
                <input
                  type="text"
                  value={standort.telefon}
                  onChange={e => setStandortField(key, 'telefon', e.target.value)}
                  placeholder="0XXX / XXXXX - 0"
                  className="bg-bg border border-border rounded-sm text-[11px] px-2 py-1 font-mono text-text focus:outline-none focus:border-accent transition-colors"
                />
              </div>
              {/* Delete */}
              <div className="flex items-start pt-5">
                <button
                  onClick={() => removeStandort(key)}
                  title="Standort löschen"
                  className={`${btnDanger} px-1.5 py-1 text-[10px]`}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
        <button onClick={addStandort} className={`${btnGhost} mt-3 text-[10px]`}>
          + Hinzufügen
        </button>
      </div>

      {/* ─── Save Bar ─── */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saveState === 'saving'}
          className={`${btnPrimary} disabled:opacity-50`}
        >
          {saveState === 'saving' ? 'Speichern…' : 'SPEICHERN'}
        </button>
        {saveState === 'success' && (
          <span className="text-[11px] text-ie-green font-mono">{saveMessage}</span>
        )}
        {saveState === 'error' && (
          <span className="text-[11px] text-ie-red font-mono">{saveMessage}</span>
        )}
      </div>

    </div>
  );
}
