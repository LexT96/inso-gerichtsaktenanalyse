import { useState, useEffect, useRef } from 'react';
import { apiClient } from '../../api/client';

// ─── Types ───

interface TemplateInfo {
  type: string;
  name: string;
  size: number;
  lastModified: string;
}

type TemplateUploadState = 'idle' | 'uploading' | 'success' | 'error';

interface TemplateStatus {
  state: TemplateUploadState;
  message: string;
}

const TEMPLATE_LABELS: Record<string, string> = {
  natuerliche_person: 'Natürliche Person',
  juristische_person: 'Juristische Person',
  personengesellschaft: 'Personengesellschaft',
};

const TEMPLATE_TYPES = Object.keys(TEMPLATE_LABELS);

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

  // ─── Template state ───
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [templateStatus, setTemplateStatus] = useState<Record<string, TemplateStatus>>({});
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const loadTemplates = () => {
    apiClient.get('/kanzlei/templates')
      .then(res => {
        const data = res.data;
        // Backend returns array directly or { templates: [...] }
        const list = Array.isArray(data) ? data : (data as { templates: TemplateInfo[] }).templates;
        setTemplates(list ?? []);
      })
      .catch(() => {
        // Non-critical — template list may not be available yet
      });
  };

  useEffect(() => {
    apiClient.get('/kanzlei')
      .then(res => { setData(res.data as KanzleiData); })
      .catch(err => {
        const msg = err?.response?.data?.error || err?.message || 'Ladefehler';
        setLoadError(msg);
      })
      .finally(() => setLoading(false));
    loadTemplates();
  }, []);

  const handleDownload = async (type: string) => {
    try {
      const response = await apiClient.get(`/kanzlei/templates/${type}/download`, { responseType: 'blob' });
      const blob = new Blob([response.data as BlobPart]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Gutachten_Muster_${type}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } }; message?: string };
      setTemplateStatus(prev => ({
        ...prev,
        [type]: { state: 'error', message: axiosErr?.response?.data?.error || axiosErr?.message || 'Download fehlgeschlagen' },
      }));
    }
  };

  const handleUpload = async (type: string, file: File) => {
    setTemplateStatus(prev => ({ ...prev, [type]: { state: 'uploading', message: '' } }));
    try {
      const formData = new FormData();
      formData.append('template', file);
      const res = await apiClient.put(`/kanzlei/templates/${type}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const body = res.data as { ok: boolean; message?: string; missingPlaceholders?: string[] };
      const msg = body.message || 'Vorlage erfolgreich aktualisiert';
      const missing = body.missingPlaceholders?.length
        ? ` (Fehlende Platzhalter: ${body.missingPlaceholders.join(', ')})`
        : '';
      setTemplateStatus(prev => ({ ...prev, [type]: { state: 'success', message: `${msg}${missing}` } }));
      loadTemplates();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } }; message?: string };
      setTemplateStatus(prev => ({
        ...prev,
        [type]: { state: 'error', message: axiosErr?.response?.data?.error || axiosErr?.message || 'Upload fehlgeschlagen' },
      }));
    }
  };

  const handleRollback = async (type: string) => {
    setTemplateStatus(prev => ({ ...prev, [type]: { state: 'uploading', message: '' } }));
    try {
      const res = await apiClient.post(`/kanzlei/templates/${type}/rollback`);
      const body = res.data as { ok: boolean; message?: string };
      setTemplateStatus(prev => ({
        ...prev,
        [type]: { state: 'success', message: body.message || 'Vorlage zurückgesetzt' },
      }));
      loadTemplates();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } }; message?: string };
      setTemplateStatus(prev => ({
        ...prev,
        [type]: { state: 'error', message: axiosErr?.response?.data?.error || axiosErr?.message || 'Zurücksetzen fehlgeschlagen' },
      }));
    }
  };

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

  // ─── Insolvenzgerichte handlers ───

  function setGerichtField(key: string, field: 'name' | 'adresse' | 'plz_ort', value: string) {
    if (!data) return;
    const current = data.insolvenzgerichte[key] ?? { name: '', adresse: '', plz_ort: '' };
    setData({
      ...data,
      insolvenzgerichte: { ...data.insolvenzgerichte, [key]: { ...current, [field]: value } },
    });
  }

  function setGerichtKey(oldKey: string, newKey: string) {
    if (!data || newKey === oldKey || !newKey.trim()) return;
    const entries = Object.entries(data.insolvenzgerichte);
    const reordered = entries.map(([k, v]) => k === oldKey
      ? [newKey, v] as [string, { name: string; adresse: string; plz_ort: string }]
      : [k, v] as [string, { name: string; adresse: string; plz_ort: string }]
    );
    setData({ ...data, insolvenzgerichte: Object.fromEntries(reordered) });
  }

  function addGericht() {
    if (!data) return;
    let key = 'Neu';
    let n = 1;
    while (key in data.insolvenzgerichte) { key = `Neu ${n++}`; }
    setData({
      ...data,
      insolvenzgerichte: { ...data.insolvenzgerichte, [key]: { name: '', adresse: '', plz_ort: '' } },
    });
  }

  function removeGericht(key: string) {
    if (!data) return;
    const updated = { ...data.insolvenzgerichte };
    delete updated[key];
    setData({ ...data, insolvenzgerichte: updated });
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
  const gerichtEntries = Object.entries(data.insolvenzgerichte);

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

      {/* ─── Partner & Anwälte (grouped by category) ─── */}
      {KATEGORIEN.map(kat => {
        const members = data.partner
          .map((p, idx) => ({ ...p, idx }))
          .filter(p => p.kategorie === kat);
        return (
          <div key={kat} className={cardClass}>
            <SectionLabel>{kat} ({members.length})</SectionLabel>
            <div className="space-y-2">
              {members.map(p => (
                <div key={p.idx} className="grid grid-cols-[1fr_1.5fr_28px] gap-2 items-start bg-bg/50 border border-border/40 rounded p-2">
                  <div className="flex flex-col gap-1">
                    <span className={labelClass}>Name</span>
                    <input
                      type="text"
                      value={p.name}
                      onChange={e => setPartnerField(p.idx, 'name', e.target.value)}
                      placeholder="Vollständiger Name"
                      className="bg-bg border border-border rounded-sm text-[11px] px-2 py-1 font-mono text-text focus:outline-none focus:border-accent transition-colors"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className={labelClass}>Titel / Fachgebiete</span>
                    <textarea
                      value={p.titel}
                      onChange={e => setPartnerField(p.idx, 'titel', e.target.value)}
                      placeholder="Fachanwalt für …"
                      rows={2}
                      className="bg-bg border border-border rounded-sm text-[11px] px-2 py-1 font-mono text-text focus:outline-none focus:border-accent transition-colors resize-y min-h-[44px]"
                    />
                  </div>
                  <div className="flex items-start pt-5">
                    <button
                      onClick={() => removePartner(p.idx)}
                      title="Eintrag löschen"
                      className={`${btnDanger} px-1.5 py-1 text-[10px]`}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={() => {
                if (!data) return;
                setData({ ...data, partner: [...data.partner, { name: '', titel: '', kategorie: kat }] });
              }}
              className={`${btnGhost} mt-2 w-full text-center text-[10px]`}
            >
              + {kat === 'PARTNER' ? 'Partner' : kat === 'ANGESTELLTE RECHTSANWÄLTE' ? 'Angestellte/r' : 'Of Counsel'} hinzufügen
            </button>
          </div>
        );
      })}

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
        <button onClick={addStandort} className={`${btnGhost} mt-2 w-full text-center text-[10px]`}>
          + Standort hinzufügen
        </button>
      </div>

      {/* ─── Insolvenzgerichte ─── */}
      <div className={cardClass}>
        <SectionLabel>Insolvenzgerichte ({gerichtEntries.length})</SectionLabel>
        <div className="text-[9px] text-text-dim leading-relaxed mb-2">
          Empfänger-Adressen für die Gutachten-Briefköpfe. Schlüssel = Stadt (für die Substring-Erkennung aus dem extrahierten Gerichts-Namen).
        </div>
        <div className="space-y-2">
          {gerichtEntries.map(([key, gericht]) => (
            <div key={key} className="grid grid-cols-[140px_1fr_1fr_140px_28px] gap-2 items-start bg-bg/50 border border-border/40 rounded p-2">
              {/* Stadt (key) */}
              <div className="flex flex-col gap-1">
                <span className={labelClass}>Stadt</span>
                <input
                  type="text"
                  value={key}
                  onChange={e => setGerichtKey(key, e.target.value)}
                  className="bg-bg border border-border rounded-sm text-[11px] px-2 py-1 font-mono text-text focus:outline-none focus:border-accent transition-colors"
                />
              </div>
              {/* Name */}
              <div className="flex flex-col gap-1">
                <span className={labelClass}>Name</span>
                <input
                  type="text"
                  value={gericht.name}
                  onChange={e => setGerichtField(key, 'name', e.target.value)}
                  placeholder="Amtsgericht XYZ"
                  className="bg-bg border border-border rounded-sm text-[11px] px-2 py-1 font-mono text-text focus:outline-none focus:border-accent transition-colors"
                />
              </div>
              {/* Adresse */}
              <div className="flex flex-col gap-1">
                <span className={labelClass}>Adresse</span>
                <input
                  type="text"
                  value={gericht.adresse}
                  onChange={e => setGerichtField(key, 'adresse', e.target.value)}
                  placeholder="Straße Nr."
                  className="bg-bg border border-border rounded-sm text-[11px] px-2 py-1 font-mono text-text focus:outline-none focus:border-accent transition-colors"
                />
              </div>
              {/* PLZ + Ort */}
              <div className="flex flex-col gap-1">
                <span className={labelClass}>PLZ + Ort</span>
                <input
                  type="text"
                  value={gericht.plz_ort}
                  onChange={e => setGerichtField(key, 'plz_ort', e.target.value)}
                  placeholder="54290 Trier"
                  className="bg-bg border border-border rounded-sm text-[11px] px-2 py-1 font-mono text-text focus:outline-none focus:border-accent transition-colors"
                />
              </div>
              {/* Delete */}
              <div className="flex items-start pt-5">
                <button
                  onClick={() => removeGericht(key)}
                  title="Gericht löschen"
                  className={`${btnDanger} px-1.5 py-1 text-[10px]`}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
        <button onClick={addGericht} className={`${btnGhost} mt-2 w-full text-center text-[10px]`}>
          + Insolvenzgericht hinzufügen
        </button>
      </div>

      {/* ─── Gutachten-Vorlagen ─── */}
      <div className={cardClass}>
        <SectionLabel>Gutachten-Vorlagen</SectionLabel>
        <div className="space-y-2">
          {TEMPLATE_TYPES.map(type => {
            const info = templates.find(t => t.type === type);
            const status = templateStatus[type];
            const label = TEMPLATE_LABELS[type];
            const isBusy = status?.state === 'uploading';
            return (
              <div key={type} className="bg-bg/50 border border-border/40 rounded p-3 flex flex-col gap-2">
                {/* Header row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] font-mono text-text">{label}</span>
                    {info ? (
                      <span className={`${labelClass} normal-case tracking-normal`}>
                        {(info.size / 1024).toFixed(0)} KB — {new Date(info.lastModified).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                      </span>
                    ) : (
                      <span className={`${labelClass} normal-case tracking-normal text-text-dim`}>Keine Datei gefunden</span>
                    )}
                  </div>
                  {/* Action buttons */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => handleDownload(type)}
                      disabled={isBusy || !info}
                      className={`${btnGhost} disabled:opacity-40`}
                      title="Vorlage herunterladen"
                    >
                      Herunterladen
                    </button>
                    <button
                      onClick={() => fileInputRefs.current[type]?.click()}
                      disabled={isBusy}
                      className={`${btnPrimary} disabled:opacity-40`}
                      title="Neue Version hochladen"
                    >
                      {isBusy ? 'Lädt…' : 'Neue Version hochladen'}
                    </button>
                    <button
                      onClick={() => handleRollback(type)}
                      disabled={isBusy}
                      className={`${btnDanger} disabled:opacity-40`}
                      title="Auf vorherige Version zurücksetzen"
                    >
                      Zurücksetzen
                    </button>
                    {/* Hidden file input */}
                    <input
                      ref={el => { fileInputRefs.current[type] = el; }}
                      type="file"
                      accept=".docx"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) handleUpload(type, file);
                        // Reset so the same file can be re-selected
                        e.target.value = '';
                      }}
                    />
                  </div>
                </div>
                {/* Status message */}
                {status && status.message && (
                  <div className={`text-[10px] font-mono ${status.state === 'error' ? 'text-ie-red' : 'text-ie-green'}`}>
                    {status.message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
