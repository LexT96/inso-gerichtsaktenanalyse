import { useState, useMemo } from 'react';
import { apiClient } from '../../api/client';
import { useVerwalter } from '../../hooks/useVerwalter';
import { useSachbearbeiter } from '../../hooks/useSachbearbeiter';
import { VerwalterManager } from './VerwalterManager';
import type { ExtractionResult, VerwalterProfile, SachbearbeiterProfile, Pruefstatus } from '../../types/extraction';

interface GutachtenWizardProps {
  result: ExtractionResult;
  extractionId: number;
  onUpdateField: (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => void;
  onClose: () => void;
}

type TemplateType = 'juristische_person' | 'personengesellschaft' | 'natuerliche_person';

interface SlotData {
  id: string;
  context: string;
  original: string;
  value: string;
  hint: string;
  status: 'filled' | 'todo' | 'editorial';
}

const JURISTISCHE_KEYWORDS = ['GmbH', 'UG', 'AG', 'SE', 'eG', 'gGmbH', 'KGaA', 'e.V.', 'Stiftung'];
const PERSONEN_KEYWORDS = ['OHG', 'KG', 'GbR', 'PartG'];

function detectTemplateType(rechtsform: string | null | undefined): TemplateType {
  if (!rechtsform) return 'natuerliche_person';
  const rf = rechtsform.trim();
  if (JURISTISCHE_KEYWORDS.some(k => rf.includes(k))) return 'juristische_person';
  if (PERSONEN_KEYWORDS.some(k => rf.includes(k))) return 'personengesellschaft';
  return 'natuerliche_person';
}

function templateLabel(type: TemplateType): string {
  switch (type) {
    case 'juristische_person': return 'juristische Person';
    case 'personengesellschaft': return 'Personengesellschaft';
    case 'natuerliche_person': return 'natürliche Person';
  }
}

const STEP_LABELS = ['Verwalter', 'Sachbearbeiter', 'Schuldner & Verfahren', 'Fehlende Angaben', 'Generieren'];

const STANDORT_DATA: Record<string, { adresse: string; telefon: string }> = {
  'Trier': { adresse: 'Balduinstraße 22-24, 54290 Trier', telefon: '0651 / 170 830 - 0' },
  'Zell/Mosel': { adresse: 'Schlossstraße 7, 56856 Zell', telefon: '06542 / 9699 - 0' },
  'Wiesbaden': { adresse: 'Luisenstraße 7, 65185 Wiesbaden', telefon: '0611 / 950 157 - 0' },
  'Koblenz': { adresse: 'Löhrstraße 99, 56068 Koblenz', telefon: '0261 / 134 69 - 0' },
  'Bad Kreuznach': { adresse: 'Kurhausstraße 15, 55543 Bad Kreuznach', telefon: '0671 / 920 148 - 0' },
};

export function GutachtenWizard({ result, extractionId, onUpdateField, onClose }: GutachtenWizardProps) {
  const [step, setStep] = useState(1);
  const [selectedVerwalter, setSelectedVerwalter] = useState<VerwalterProfile | null>(null);
  const [showManager, setShowManager] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [slots, setSlots] = useState<SlotData[]>([]);

  // Extra inputs not covered by Verwalter profile or extraction
  const [anderkontoIban, setAnderkontoIban] = useState('');
  const [anderkontoBank, setAnderkontoBank] = useState('');
  const [geschaeftsfuehrer, setGeschaeftsfuehrer] = useState('');
  const [lastGavv, setLastGavv] = useState('');
  const [selectedSachbearbeiter, setSelectedSachbearbeiter] = useState<SachbearbeiterProfile | null>(null);
  const [showNewSb, setShowNewSb] = useState(false);
  const [newSbName, setNewSbName] = useState('');
  const [newSbEmail, setNewSbEmail] = useState('');
  const [newSbDurchwahl, setNewSbDurchwahl] = useState('');

  const { profiles, loading: loadingProfiles, createProfile, updateProfile, deleteProfile } = useVerwalter();
  const { profiles: sbProfiles, loading: loadingSb, createProfile: createSb } = useSachbearbeiter();

  const templateType = useMemo(
    () => detectTemplateType(result.schuldner?.rechtsform?.wert as string | null),
    [result.schuldner?.rechtsform?.wert],
  );
  const isJuristisch = templateType === 'juristische_person';
  const isNatuerlich = templateType === 'natuerliche_person';

  // When Verwalter is selected, pre-fill anderkonto and Sachbearbeiter if available
  const handleSelectVerwalter = (profile: VerwalterProfile) => {
    setSelectedVerwalter(profile);
    if (profile.anderkonto_iban) setAnderkontoIban(profile.anderkonto_iban);
    if (profile.anderkonto_bank) setAnderkontoBank(profile.anderkonto_bank);
  };

  // Key fields to check in Step 2
  const schuldnerFields = useMemo(() => {
    const s = result.schuldner;
    const v = result.verfahrensdaten;
    const base = [
      { label: 'Aktenzeichen', value: v?.aktenzeichen?.wert, path: 'verfahrensdaten.aktenzeichen' },
      { label: 'Gericht', value: v?.gericht?.wert, path: 'verfahrensdaten.gericht' },
      { label: 'Beschlussdatum', value: v?.beschlussdatum?.wert, path: 'verfahrensdaten.beschlussdatum' },
    ];
    if (isJuristisch || templateType === 'personengesellschaft') {
      base.push(
        { label: 'Firma', value: s?.firma?.wert, path: 'schuldner.firma' },
        { label: 'Rechtsform', value: s?.rechtsform?.wert, path: 'schuldner.rechtsform' },
        { label: 'Betriebsstätte', value: s?.betriebsstaette_adresse?.wert, path: 'schuldner.betriebsstaette_adresse' },
        { label: 'HRB', value: s?.handelsregisternummer?.wert, path: 'schuldner.handelsregisternummer' },
      );
    } else {
      base.push(
        { label: 'Name', value: s?.name?.wert, path: 'schuldner.name' },
        { label: 'Vorname', value: s?.vorname?.wert, path: 'schuldner.vorname' },
        { label: 'Geburtsdatum', value: s?.geburtsdatum?.wert, path: 'schuldner.geburtsdatum' },
        { label: 'Familienstand', value: s?.familienstand?.wert, path: 'schuldner.familienstand' },
        { label: 'Adresse', value: s?.aktuelle_adresse?.wert, path: 'schuldner.aktuelle_adresse' },
      );
    }
    return base;
  }, [result, isJuristisch, templateType]);

  const missingCount = schuldnerFields.filter(f => !f.value).length;

  const buildUserInputs = (): Record<string, string> => {
    const body: Record<string, string> = {
      verwalter_diktatzeichen: selectedVerwalter?.diktatzeichen || '',
      verwalter_geschlecht: selectedVerwalter?.geschlecht || 'maennlich',
    };
    // Pass Verwalter profile data to override extraction values
    if (selectedVerwalter?.name) body.verwalter_name = selectedVerwalter.name;
    if (selectedVerwalter?.titel) body.verwalter_titel = selectedVerwalter.titel;
    if (selectedVerwalter?.standort) body.verwalter_standort = selectedVerwalter.standort;
    // Kanzlei name is always the same; address and phone depend on standort
    body.verwalter_kanzlei = 'Prof. Dr. Dr. Thomas B. Schmidt Insolvenzverwalter Rechtsanwälte Partnerschaft mbB';
    const standort = STANDORT_DATA[selectedVerwalter?.standort || ''];
    body.verwalter_adresse = standort?.adresse || 'Schlossstraße 7, 56856 Zell';
    body.verwalter_standort_telefon = standort?.telefon || '0651 / 170 830 - 0';
    if (selectedSachbearbeiter?.name) body.sachbearbeiter_name = selectedSachbearbeiter.name;
    if (selectedSachbearbeiter?.email) body.sachbearbeiter_email = selectedSachbearbeiter.email;
    if (selectedSachbearbeiter?.durchwahl) body.sachbearbeiter_durchwahl = selectedSachbearbeiter.durchwahl;
    // Anderkonto: prefer wizard input, fallback to profile
    const iban = anderkontoIban.trim() || selectedVerwalter?.anderkonto_iban || '';
    const bank = anderkontoBank.trim() || selectedVerwalter?.anderkonto_bank || '';
    if (iban) body.anderkonto_iban = iban;
    if (bank) body.anderkonto_bank = bank;
    if (isJuristisch && geschaeftsfuehrer.trim()) body.geschaeftsfuehrer = geschaeftsfuehrer.trim();
    if (isNatuerlich && lastGavv.trim()) body.last_gavv = lastGavv.trim();
    return body;
  };

  const handlePrepare = async () => {
    setPreparing(true);
    setError('');
    try {
      const body = buildUserInputs();
      const response = await apiClient.post(`/generate-gutachten/${extractionId}/prepare`, body);
      const returnedSlots: SlotData[] = (response.data.slots || []).map((s: SlotData) => ({
        id: s.id, context: s.context || '', original: s.original || '',
        value: s.value || '', hint: s.hint || s.original || '', status: s.status,
      }));
      setSlots(returnedSlots);
    } catch (err) {
      const axErr = err as { response?: { data?: { error?: string } } };
      setError(axErr?.response?.data?.error || 'Vorbereitung fehlgeschlagen');
    } finally {
      setPreparing(false);
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setError('');
    try {
      const finalSlots = slots.map(s => ({ id: s.id, value: s.value }));
      const body = { userInputs: buildUserInputs(), slots: finalSlots };
      const response = await apiClient.post(
        `/generate-gutachten/${extractionId}/generate`, body, { responseType: 'blob' },
      );
      const blob = new Blob([response.data], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Gutachten_${extractionId}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      const axErr = err as { response?: { data?: Blob } };
      if (axErr?.response?.data instanceof Blob) {
        try {
          const text = await axErr.response.data.text();
          setError(JSON.parse(text).error || 'Generierung fehlgeschlagen');
        } catch {
          setError('Generierung fehlgeschlagen');
        }
      } else {
        setError('Generierung fehlgeschlagen');
      }
    } finally {
      setGenerating(false);
    }
  };

  const canAdvance = (s: number): boolean => {
    if (s === 1) return selectedVerwalter !== null;
    if (s === 2) return selectedSachbearbeiter !== null;
    if (s === 3) return missingCount === 0; // Schuldner & Verfahren
    return true;
  };

  const filledSlots = slots.filter(s => s.status === 'filled').length;
  const todoSlots = slots.filter(s => s.status === 'todo').length;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header with step indicators */}
        <div className="flex items-center gap-1 p-3 border-b border-border">
          {STEP_LABELS.map((label, i) => (
            <div key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-border mx-1">›</span>}
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
                i + 1 === step ? 'bg-accent text-white font-bold' :
                i + 1 < step ? 'bg-accent/20 text-accent' : 'text-text-dim'
              }`}>
                {i + 1}
              </span>
              <span className={`text-[10px] ${i + 1 === step ? 'text-text font-semibold' : 'text-text-dim'}`}>
                {label}
              </span>
            </div>
          ))}
          <div className="flex-1" />
          <button onClick={onClose} className="text-text-muted hover:text-text text-lg leading-none">×</button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {error && (
            <div className="mb-3 p-2 bg-red-900/20 border border-red-800/40 rounded text-[11px] text-red-300">{error}</div>
          )}

          {/* Step 1: Verwalter */}
          {step === 1 && (
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Verwalter/in auswählen *</label>
                <select
                  value={selectedVerwalter?.id || ''}
                  onChange={e => {
                    const p = profiles.find(p => p.id === Number(e.target.value));
                    if (p) handleSelectVerwalter(p);
                  }}
                  className="w-full px-2 py-2 bg-bg border border-border rounded text-[12px] text-text"
                >
                  <option value="">— Bitte wählen —</option>
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              {selectedVerwalter && (
                <div className="grid grid-cols-2 gap-2">
                  {[
                    ['Diktatzeichen', selectedVerwalter.diktatzeichen],
                    ['Geschlecht', selectedVerwalter.geschlecht === 'weiblich' ? 'weiblich' : 'männlich'],
                    ['Standort', selectedVerwalter.standort],
                  ].map(([l, v]) => (
                    <div key={l} className="bg-bg border border-border/60 rounded px-3 py-2">
                      <div className="text-[9px] text-text-dim">{l}</div>
                      <div className="text-[12px] text-text">{v || '—'}</div>
                    </div>
                  ))}
                </div>
              )}
              {loadingProfiles ? (
                <p className="text-[10px] text-text-muted">Lade Profile…</p>
              ) : profiles.length === 0 ? (
                <p className="text-[10px] text-text-muted">Noch keine Verwalter-Profile angelegt.</p>
              ) : null}
              <button onClick={() => setShowManager(true)}
                className="text-[10px] text-accent hover:underline">
                Verwalter-Profile verwalten
              </button>
            </div>
          )}

          {/* Step 2: Sachbearbeiter */}
          {step === 2 && (
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Sachbearbeiter/in auswählen *</label>
                <select
                  value={selectedSachbearbeiter?.id || ''}
                  onChange={e => {
                    const p = sbProfiles.find(p => p.id === Number(e.target.value));
                    if (p) setSelectedSachbearbeiter(p);
                  }}
                  className="w-full px-2 py-2 bg-bg border border-border rounded text-[12px] text-text"
                >
                  <option value="">— Bitte wählen —</option>
                  {sbProfiles.map(p => (
                    <option key={p.id} value={p.id}>{p.name} {p.email ? `(${p.email})` : ''}</option>
                  ))}
                </select>
              </div>
              {selectedSachbearbeiter && (
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ['Name', selectedSachbearbeiter.name],
                    ['E-Mail', selectedSachbearbeiter.email],
                    ['Durchwahl', selectedSachbearbeiter.durchwahl],
                  ].map(([l, v]) => (
                    <div key={l} className="bg-bg border border-border/60 rounded px-3 py-2">
                      <div className="text-[9px] text-text-dim">{l}</div>
                      <div className="text-[12px] text-text">{v || '—'}</div>
                    </div>
                  ))}
                </div>
              )}
              {loadingSb ? (
                <p className="text-[10px] text-text-muted">Lade Profile…</p>
              ) : sbProfiles.length === 0 && !showNewSb ? (
                <p className="text-[10px] text-text-muted">Noch keine Sachbearbeiter angelegt.</p>
              ) : null}

              {/* Inline create */}
              {!showNewSb ? (
                <button onClick={() => setShowNewSb(true)}
                  className="text-[10px] text-accent hover:underline">
                  + Neuen Sachbearbeiter anlegen
                </button>
              ) : (
                <div className="p-3 bg-bg border border-border/60 rounded-lg space-y-2">
                  <div className="text-[10px] text-text-dim font-semibold">Neuer Sachbearbeiter</div>
                  <input value={newSbName} onChange={e => setNewSbName(e.target.value)}
                    className="w-full px-2 py-1.5 bg-surface border border-border rounded text-[11px] text-text"
                    placeholder="Name *" />
                  <div className="grid grid-cols-2 gap-2">
                    <input value={newSbEmail} onChange={e => setNewSbEmail(e.target.value)}
                      className="w-full px-2 py-1.5 bg-surface border border-border rounded text-[11px] text-text font-mono"
                      placeholder="E-Mail" />
                    <input value={newSbDurchwahl} onChange={e => setNewSbDurchwahl(e.target.value)}
                      className="w-full px-2 py-1.5 bg-surface border border-border rounded text-[11px] text-text font-mono"
                      placeholder="Durchwahl" />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        if (!newSbName.trim()) return;
                        const created = await createSb({ name: newSbName.trim(), email: newSbEmail.trim(), durchwahl: newSbDurchwahl.trim() });
                        setSelectedSachbearbeiter(created);
                        setNewSbName(''); setNewSbEmail(''); setNewSbDurchwahl('');
                        setShowNewSb(false);
                      }}
                      disabled={!newSbName.trim()}
                      className="px-3 py-1 bg-accent text-white rounded text-[10px] font-semibold disabled:opacity-50">
                      Speichern
                    </button>
                    <button onClick={() => setShowNewSb(false)}
                      className="px-3 py-1 text-[10px] text-text-muted hover:text-text">
                      Abbrechen
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Schuldner & Verfahren */}
          {step === 3 && (
            <div className="space-y-3">
              {missingCount > 0 && (
                <div className="p-2 bg-accent/10 border border-accent/30 rounded text-[11px] text-accent">
                  ⚠ {missingCount} Feld{missingCount > 1 ? 'er' : ''} fehlt — bitte ergänzen
                </div>
              )}
              {missingCount === 0 && (
                <div className="p-2 bg-green-900/20 border border-green-800/40 rounded text-[11px] text-green-400">
                  ✓ Alle Pflichtfelder vorhanden
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {schuldnerFields.map(f => {
                  const empty = !f.value;
                  return (
                    <div key={f.path} className={`px-3 py-2 rounded border ${
                      empty ? 'border-accent/50 bg-accent/5' : 'border-border/60 bg-bg'
                    }`}>
                      <div className={`text-[9px] ${empty ? 'text-accent' : 'text-text-dim'}`}>
                        {f.label} {empty && '⚠'}
                      </div>
                      {empty ? (
                        <input
                          className="w-full text-[12px] bg-transparent border-none outline-none text-accent placeholder-accent/40 mt-0.5"
                          placeholder="Eingeben…"
                          onBlur={e => {
                            if (e.target.value.trim()) {
                              onUpdateField(f.path, e.target.value.trim(), 'manuell');
                            }
                          }}
                        />
                      ) : (
                        <div className="text-[12px] text-text truncate">{String(f.value)}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 4: Fehlende Angaben */}
          {step === 4 && (
            <div className="space-y-3">
              {!selectedVerwalter?.anderkonto_iban && (
                <div>
                  <label className="text-[10px] text-text-dim block mb-1">Anderkonto IBAN</label>
                  <input value={anderkontoIban} onChange={e => setAnderkontoIban(e.target.value)}
                    className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text font-mono"
                    placeholder="DE__ ____ ____ ____ ____ __" />
                </div>
              )}
              {!selectedVerwalter?.anderkonto_bank && !anderkontoBank && (
                <div>
                  <label className="text-[10px] text-text-dim block mb-1">Anderkonto Bank</label>
                  <input value={anderkontoBank} onChange={e => setAnderkontoBank(e.target.value)}
                    className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text"
                    placeholder="z.B. Sparkasse Trier" />
                </div>
              )}
              {isJuristisch && (
                <div>
                  <label className="text-[10px] text-text-dim block mb-1">Geschäftsführer</label>
                  <input value={geschaeftsfuehrer} onChange={e => setGeschaeftsfuehrer(e.target.value)}
                    className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text"
                    placeholder="Name des Geschäftsführers" />
                </div>
              )}
              {isNatuerlich && (
                <div>
                  <label className="text-[10px] text-text-dim block mb-1">Last GAVV</label>
                  <input value={lastGavv} onChange={e => setLastGavv(e.target.value)}
                    className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text"
                    placeholder="Datum der letzten GAVV" />
                </div>
              )}
              {selectedVerwalter?.anderkonto_iban && !isJuristisch && !lastGavv && (
                <div className="p-3 bg-green-900/20 border border-green-800/40 rounded text-[11px] text-green-400 text-center">
                  ✓ Alle Angaben vorhanden — Gutachten kann generiert werden
                </div>
              )}
            </div>
          )}

          {/* Step 5: Vorschau & Generieren */}
          {step === 5 && (
            <div className="space-y-4">
              {!preparing && slots.length === 0 && (
                <div className="text-center py-6">
                  <p className="text-[11px] text-text-muted mb-3">Gutachten wird vorbereitet — KI füllt Textbausteine aus.</p>
                  <button onClick={handlePrepare}
                    className="px-6 py-2 bg-accent text-white rounded text-[11px] font-semibold">
                    Vorbereitung starten
                  </button>
                </div>
              )}
              {preparing && (
                <div className="text-center py-8">
                  <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full mx-auto mb-3" />
                  <p className="text-[11px] text-text-muted">KI-Textbausteine werden generiert…</p>
                </div>
              )}
              {slots.length > 0 && !preparing && (
                <>
                  <div className="flex gap-3">
                    <div className="flex-1 bg-bg border border-border rounded-lg p-3 text-center">
                      <div className="text-xl font-bold text-green-400">{filledSlots}</div>
                      <div className="text-[9px] text-text-dim">KI-Felder gefüllt</div>
                    </div>
                    <div className="flex-1 bg-bg border border-border rounded-lg p-3 text-center">
                      <div className="text-xl font-bold text-amber-400">{todoSlots}</div>
                      <div className="text-[9px] text-text-dim">TODO (manuell)</div>
                    </div>
                    <div className="flex-1 bg-bg border border-border rounded-lg p-3 text-center">
                      <div className="text-xl font-bold text-text">{slots.length}</div>
                      <div className="text-[9px] text-text-dim">Slots gesamt</div>
                    </div>
                  </div>
                  <div className="bg-bg border border-border rounded-lg p-3">
                    <div className="text-[10px] text-text-dim mb-1">Vorlage</div>
                    <div className="text-[12px] text-text font-semibold">Gutachten Muster {templateLabel(templateType)}</div>
                  </div>
                  <button onClick={handleGenerate} disabled={generating}
                    className="w-full py-3 bg-accent text-white rounded-md text-[12px] font-mono font-semibold hover:bg-accent/90 disabled:opacity-50 transition-all tracking-wide active:scale-[0.98]">
                    {generating ? 'Wird generiert…' : 'GUTACHTEN GENERIEREN'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer with navigation */}
        <div className="flex justify-between p-3 border-t border-border">
          <button onClick={() => setStep(s => Math.max(1, s - 1))} disabled={step === 1}
            className="px-4 py-1.5 text-[11px] text-text-muted hover:text-text disabled:opacity-30">
            ← Zurück
          </button>
          {step < 5 ? (
            <button onClick={() => {
              if (step === 4) handlePrepare(); // Start preparation when moving to step 5
              setStep(s => Math.min(5, s + 1));
            }} disabled={!canAdvance(step)}
              className="px-4 py-1.5 bg-accent text-white rounded text-[11px] font-semibold disabled:opacity-50">
              Weiter →
            </button>
          ) : (
            <div /> // Generate button is in the step 5 content
          )}
        </div>
      </div>

      {/* Verwalter Manager overlay */}
      {showManager && (
        <VerwalterManager
          profiles={profiles}
          onSave={createProfile}
          onUpdate={updateProfile}
          onDelete={deleteProfile}
          onClose={() => setShowManager(false)}
        />
      )}
    </div>
  );
}
