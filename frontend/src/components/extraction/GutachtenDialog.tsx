import { useState, useMemo } from 'react';
import { apiClient } from '../../api/client';
import type { ExtractionResult } from '../../types/extraction';

interface GutachtenDialogProps {
  result: ExtractionResult;
  extractionId: number;
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

export function GutachtenDialog({ result, extractionId, onClose }: GutachtenDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [preparing, setPreparing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');

  // Step 1 inputs
  const [diktatzeichen, setDiktatzeichen] = useState('');
  const [geschlecht, setGeschlecht] = useState<'maennlich' | 'weiblich'>('maennlich');
  const [anderkontoIban, setAnderkontoIban] = useState('');
  const [anderkontoBank, setAnderkontoBank] = useState('');
  const [geschaeftsfuehrer, setGeschaeftsfuehrer] = useState('');
  const [lastGavv, setLastGavv] = useState('');

  // Step 2 data
  const [slots, setSlots] = useState<SlotData[]>([]);
  const [editedValues, setEditedValues] = useState<Map<string, string>>(new Map());

  const templateType = useMemo(
    () => detectTemplateType(result.schuldner?.rechtsform?.wert as string | null),
    [result.schuldner?.rechtsform?.wert],
  );

  const isJuristisch = templateType === 'juristische_person';
  const isNatuerlich = templateType === 'natuerliche_person';

  const aktenzeichen = (result.verfahrensdaten?.aktenzeichen?.wert as string) || '—';
  const schuldnerName = isJuristisch || templateType === 'personengesellschaft'
    ? (result.schuldner?.firma?.wert as string) || '—'
    : [result.schuldner?.vorname?.wert, result.schuldner?.name?.wert].filter(Boolean).join(' ') || '—';
  const verwalterName = (result.gutachterbestellung?.gutachter_name?.wert as string) || '—';

  const canPrepare = diktatzeichen.trim().length > 0;

  const buildUserInputs = (): Record<string, string> => {
    const body: Record<string, string> = {
      verwalter_diktatzeichen: diktatzeichen.trim(),
      verwalter_geschlecht: geschlecht,
    };
    if (anderkontoIban.trim()) body.anderkonto_iban = anderkontoIban.trim();
    if (anderkontoBank.trim()) body.anderkonto_bank = anderkontoBank.trim();
    if (isJuristisch && geschaeftsfuehrer.trim()) body.geschaeftsfuehrer = geschaeftsfuehrer.trim();
    if (isNatuerlich && lastGavv.trim()) body.last_gavv = lastGavv.trim();
    return body;
  };

  // Step 1 -> Step 2: Prepare
  const handlePrepare = async () => {
    if (!canPrepare) return;

    setPreparing(true);
    setError('');

    try {
      const body = buildUserInputs();
      const response = await apiClient.post(
        `/generate-gutachten/${extractionId}/prepare`,
        body,
      );
      const returnedSlots: SlotData[] = (response.data.slots || []).map((s: SlotData) => ({
        id: s.id,
        context: s.context || '',
        original: s.original || '',
        value: s.value || '',
        hint: s.hint || s.original || '',
        status: s.status,
      }));
      setSlots(returnedSlots);
      setEditedValues(new Map());
      setStep(2);
    } catch (err) {
      const axErr = err as { response?: { data?: { error?: string } } };
      setError(axErr?.response?.data?.error || 'Vorbereitung fehlgeschlagen');
    } finally {
      setPreparing(false);
    }
  };

  // Step 2 -> Download
  const handleGenerate = async () => {
    setGenerating(true);
    setError('');

    try {
      const finalSlots = slots.map(s => ({
        id: s.id,
        value: editedValues.get(s.id) ?? s.value,
      }));
      const body = {
        userInputs: buildUserInputs(),
        slots: finalSlots,
      };
      const response = await apiClient.post(
        `/generate-gutachten/${extractionId}/generate`,
        body,
        { responseType: 'blob' },
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
      const blobData = axErr?.response?.data;
      if (blobData instanceof Blob) {
        try {
          const text = await blobData.text();
          const parsed = JSON.parse(text);
          setError(parsed.error || 'Generierung fehlgeschlagen');
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

  const handleSlotEdit = (id: string, newValue: string) => {
    setEditedValues(prev => {
      const next = new Map(prev);
      next.set(id, newValue);
      return next;
    });
  };

  // Slot stats
  const filledCount = slots.filter(s => s.status === 'filled').length;
  const todoCount = slots.filter(s => s.status === 'todo').length;
  const editorialCount = slots.filter(s => s.status === 'editorial').length;

  // Group slots by status
  const filledSlots = slots.filter(s => s.status === 'filled');
  const todoSlots = slots.filter(s => s.status === 'todo');
  const editorialSlots = slots.filter(s => s.status === 'editorial');

  const inputClass = 'w-full px-2 py-1.5 bg-bg border border-border rounded-md text-[11px] font-mono text-text focus:border-accent focus:outline-none';

  const maxWidth = step === 1 ? 'max-w-lg' : 'max-w-2xl';
  const headerTitle = step === 1
    ? 'Gutachten generieren — Schritt 1/2'
    : 'Gutachten generieren — Slots prüfen (2/2)';

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className={`bg-surface border border-border/60 rounded-xl shadow-dropdown w-full ${maxWidth} mx-4 max-h-[90vh] overflow-y-auto`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-sm font-bold font-sans">{headerTitle}</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text text-lg leading-none transition-colors"
          >
            &times;
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
          <StepDot active={step >= 1} completed={step > 1} label="Eingaben" stepNumber="1" />
          <div className={`flex-1 h-px ${step > 1 ? 'bg-accent' : 'bg-border'}`} />
          <StepDot active={step >= 2} completed={false} label="Slots prüfen" stepNumber="2" />
        </div>

        <div className="p-5 space-y-5">
          {/* ==================== STEP 1 ==================== */}
          {step === 1 && (
            <>
              {/* Summary of auto-filled fields */}
              <div>
                <div className="text-[10px] text-text-muted uppercase tracking-wide mb-2 font-mono">
                  Automatisch aus Extraktion
                </div>
                <div className="bg-bg border border-border rounded-md p-3 space-y-1.5">
                  <SummaryRow label="Aktenzeichen" value={aktenzeichen} />
                  <SummaryRow label="Schuldner" value={schuldnerName} />
                  <SummaryRow label="Verwalter" value={verwalterName} />
                  <SummaryRow label="Vorlage" value={`Muster ${templateLabel(templateType)}`} />
                </div>
              </div>

              {/* User input fields */}
              <div>
                <div className="text-[10px] text-text-muted uppercase tracking-wide mb-2 font-mono">
                  Zusätzliche Angaben
                </div>
                <div className="space-y-3">
                  {/* Diktatzeichen - required */}
                  <div>
                    <label className="block text-[10px] text-text-muted mb-1 font-mono">
                      DIKTATZEICHEN <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={diktatzeichen}
                      onChange={e => setDiktatzeichen(e.target.value)}
                      className={inputClass}
                      placeholder="z.B. Dr. M/ab"
                      autoFocus
                    />
                  </div>

                  {/* Geschlecht - required */}
                  <div>
                    <label className="block text-[10px] text-text-muted mb-1 font-mono">
                      GESCHLECHT VERWALTER <span className="text-red-400">*</span>
                    </label>
                    <select
                      value={geschlecht}
                      onChange={e => setGeschlecht(e.target.value as 'maennlich' | 'weiblich')}
                      className={inputClass}
                    >
                      <option value="maennlich">männlich</option>
                      <option value="weiblich">weiblich</option>
                    </select>
                  </div>

                  {/* Anderkonto IBAN */}
                  <div>
                    <label className="block text-[10px] text-text-muted mb-1 font-mono">
                      ANDERKONTO IBAN
                    </label>
                    <input
                      type="text"
                      value={anderkontoIban}
                      onChange={e => setAnderkontoIban(e.target.value)}
                      className={inputClass}
                      placeholder="DE..."
                    />
                  </div>

                  {/* Anderkonto Bank */}
                  <div>
                    <label className="block text-[10px] text-text-muted mb-1 font-mono">
                      ANDERKONTO BANK
                    </label>
                    <input
                      type="text"
                      value={anderkontoBank}
                      onChange={e => setAnderkontoBank(e.target.value)}
                      className={inputClass}
                      placeholder="Name der Bank"
                    />
                  </div>

                  {/* Geschäftsführer - only for juristische Person */}
                  {isJuristisch && (
                    <div>
                      <label className="block text-[10px] text-text-muted mb-1 font-mono">
                        GESCHÄFTSFÜHRER
                      </label>
                      <input
                        type="text"
                        value={geschaeftsfuehrer}
                        onChange={e => setGeschaeftsfuehrer(e.target.value)}
                        className={inputClass}
                        placeholder="Name des Geschäftsführers"
                      />
                    </div>
                  )}

                  {/* Last GAVV - only for natürliche Person */}
                  {isNatuerlich && (
                    <div>
                      <label className="block text-[10px] text-text-muted mb-1 font-mono">
                        LAST GAVV
                      </label>
                      <input
                        type="text"
                        value={lastGavv}
                        onChange={e => setLastGavv(e.target.value)}
                        className={inputClass}
                        placeholder="Datum der letzten GAVV"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="text-[10px] text-red-400 bg-red-400/10 border border-red-400/20 rounded-md p-2">
                  {error}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={onClose}
                  className="flex-1 px-3 py-2 border border-border rounded-md text-[10px] font-mono text-text-muted hover:border-border-light transition-colors"
                >
                  ABBRECHEN
                </button>
                <button
                  onClick={handlePrepare}
                  disabled={!canPrepare || preparing}
                  className="flex-1 px-3 py-2 bg-accent text-white rounded-md text-[10px] font-mono hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {preparing ? 'VORBEREITEN...' : 'VORBEREITEN'}
                </button>
              </div>
            </>
          )}

          {/* ==================== STEP 2 ==================== */}
          {step === 2 && (
            <>
              {/* Stats bar */}
              <div className="flex items-center gap-3 text-[10px] font-mono">
                <span className="text-emerald-400">{filledCount} gefüllt</span>
                <span className="text-text-dim">&middot;</span>
                <span className="text-amber-400">{todoCount} offen</span>
                <span className="text-text-dim">&middot;</span>
                <span className="text-text-muted">{editorialCount} redaktionell</span>
              </div>

              {/* Slot list */}
              <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
                {/* Todo slots first */}
                {todoSlots.length > 0 && (
                  <SlotGroup
                    title="OFFEN"
                    slots={todoSlots}
                    borderColor="border-amber-400/30"
                    bgColor="bg-amber-400/10"
                    editedValues={editedValues}
                    onEdit={handleSlotEdit}
                    inputClass={inputClass}
                    readOnly={false}
                  />
                )}

                {/* Filled slots */}
                {filledSlots.length > 0 && (
                  <SlotGroup
                    title="GEFÜLLT"
                    slots={filledSlots}
                    borderColor="border-emerald-400/30"
                    bgColor="bg-emerald-400/10"
                    editedValues={editedValues}
                    onEdit={handleSlotEdit}
                    inputClass={inputClass}
                    readOnly={false}
                  />
                )}

                {/* Editorial slots */}
                {editorialSlots.length > 0 && (
                  <SlotGroup
                    title="REDAKTIONELL"
                    slots={editorialSlots}
                    borderColor="border-border"
                    bgColor="bg-bg"
                    editedValues={editedValues}
                    onEdit={handleSlotEdit}
                    inputClass={inputClass}
                    readOnly={true}
                  />
                )}
              </div>

              {/* Error */}
              {error && (
                <div className="text-[10px] text-red-400 bg-red-400/10 border border-red-400/20 rounded-md p-2">
                  {error}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => { setStep(1); setError(''); }}
                  className="px-3 py-2 border border-border rounded-md text-[10px] font-mono text-text-muted hover:border-border-light transition-colors"
                >
                  ZURÜCK
                </button>
                <button
                  onClick={onClose}
                  className="px-3 py-2 border border-border rounded-md text-[10px] font-mono text-text-muted hover:border-border-light transition-colors"
                >
                  ABBRECHEN
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  className="flex-1 px-3 py-2 bg-accent text-white rounded-md text-[10px] font-mono hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {generating ? 'GENERIERE...' : 'GENERIEREN & HERUNTERLADEN'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ==================== Helper Components ==================== */

function StepDot({ active, completed, label, stepNumber }: { active: boolean; completed: boolean; label: string; stepNumber: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold font-mono border transition-colors
        ${completed ? 'bg-accent border-accent text-white' :
          active ? 'border-accent text-accent' :
          'border-border text-text-muted'}`}>
        {completed ? '\u2713' : stepNumber}
      </div>
      <span className={`text-[9px] font-mono ${active ? 'text-text' : 'text-text-muted'}`}>{label}</span>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-text-dim w-24 flex-shrink-0">{label}:</span>
      <span className="text-[11px] text-text font-mono truncate">{value}</span>
    </div>
  );
}

interface SlotGroupProps {
  title: string;
  slots: SlotData[];
  borderColor: string;
  bgColor: string;
  editedValues: Map<string, string>;
  onEdit: (id: string, value: string) => void;
  inputClass: string;
  readOnly: boolean;
}

function SlotGroup({ title, slots, borderColor, bgColor, editedValues, onEdit, inputClass, readOnly }: SlotGroupProps) {
  return (
    <div>
      <div className="text-[9px] text-text-dim uppercase tracking-wide mb-1.5 font-mono">
        {title} ({slots.length})
      </div>
      <div className="space-y-2">
        {slots.map(slot => (
          <div
            key={slot.id}
            className={`border ${borderColor} ${bgColor} rounded-md p-2.5`}
          >
            <div className="flex items-baseline gap-2 mb-1">
              {slot.hint && (
                <span className="text-[10px] text-accent font-mono font-bold flex-shrink-0">
                  {slot.hint}
                </span>
              )}
              <span className="text-[9px] text-text-dim font-mono leading-tight truncate">
                {slot.context}
              </span>
            </div>
            {readOnly ? (
              <div className="text-[11px] text-text-muted font-mono italic px-2 py-1.5">
                {slot.value || '—'}
              </div>
            ) : (
              <input
                type="text"
                value={editedValues.has(slot.id) ? editedValues.get(slot.id)! : slot.value}
                onChange={e => onEdit(slot.id, e.target.value)}
                className={inputClass}
                placeholder={slot.hint || (slot.status === 'todo' ? 'Wert eingeben...' : '')}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
