import { useState } from 'react';
import type { VerwalterProfile } from '../../types/extraction';

interface VerwalterManagerProps {
  profiles: VerwalterProfile[];
  onSave: (profile: Omit<VerwalterProfile, 'id'>) => Promise<VerwalterProfile>;
  onUpdate: (id: number, updates: Partial<VerwalterProfile>) => Promise<VerwalterProfile>;
  onDelete: (id: number) => Promise<void>;
  onClose: () => void;
}

const EMPTY_PROFILE: Omit<VerwalterProfile, 'id'> = {
  name: '', titel: '', geschlecht: 'maennlich', diktatzeichen: '',
  standort: '', anderkonto_iban: '', anderkonto_bank: '',
};

export function VerwalterManager({ profiles, onSave, onUpdate, onDelete, onClose }: VerwalterManagerProps) {
  const [editing, setEditing] = useState<VerwalterProfile | Omit<VerwalterProfile, 'id'> | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!editing || !editing.name.trim()) return;
    setSaving(true);
    try {
      if ('id' in editing) {
        await onUpdate(editing.id, editing);
      } else {
        await onSave(editing);
      }
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Verwalter-Profil wirklich löschen?')) return;
    await onDelete(id);
  };

  const updateField = (field: string, value: string) => {
    if (!editing) return;
    setEditing({ ...editing, [field]: value });
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] overflow-auto">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-sm font-semibold text-text">Verwalter-Profile verwalten</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text text-lg">×</button>
        </div>

        {editing ? (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Name *</label>
                <input value={editing.name} onChange={e => updateField('name', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text" placeholder="RA Dr. Alexander Lamberty LL.M." />
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Titel</label>
                <input value={editing.titel} onChange={e => updateField('titel', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text" placeholder="Fachanwalt für Insolvenz- und Sanierungsrecht" />
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Geschlecht</label>
                <select value={editing.geschlecht} onChange={e => updateField('geschlecht', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text">
                  <option value="maennlich">männlich</option>
                  <option value="weiblich">weiblich</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Diktatzeichen</label>
                <input value={editing.diktatzeichen} onChange={e => updateField('diktatzeichen', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text" placeholder="La/Bi" />
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Standort</label>
                <input value={editing.standort} onChange={e => updateField('standort', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text" placeholder="Zell/Mosel" />
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Anderkonto IBAN</label>
                <input value={editing.anderkonto_iban} onChange={e => updateField('anderkonto_iban', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text font-mono" placeholder="DE__ ____ ____ ____" />
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Anderkonto Bank</label>
                <input value={editing.anderkonto_bank} onChange={e => updateField('anderkonto_bank', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text" placeholder="Sparkasse Trier" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditing(null)} className="px-4 py-1.5 text-[11px] text-text-muted hover:text-text">Abbrechen</button>
              <button onClick={handleSave} disabled={saving || !editing.name.trim()}
                className="px-4 py-1.5 bg-accent text-white rounded text-[11px] font-semibold disabled:opacity-50">
                {saving ? 'Speichern…' : 'Speichern'}
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4">
            {profiles.length === 0 ? (
              <p className="text-[11px] text-text-muted text-center py-6">Noch keine Profile angelegt.</p>
            ) : (
              <div className="space-y-1">
                {profiles.map(p => (
                  <div key={p.id} className="flex items-center justify-between py-2 px-3 border border-border/60 rounded hover:bg-bg/50">
                    <div>
                      <div className="text-[11px] font-semibold text-text">{p.name}</div>
                      <div className="text-[9px] text-text-dim">{p.diktatzeichen} · {p.standort}</div>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => setEditing(p)} className="px-2 py-1 text-[9px] text-text-muted hover:text-text border border-border rounded">Bearbeiten</button>
                      <button onClick={() => handleDelete(p.id)} className="px-2 py-1 text-[9px] text-red-400 hover:text-red-300 border border-border rounded">Löschen</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => setEditing({ ...EMPTY_PROFILE })}
              className="mt-3 w-full py-2 border border-dashed border-border rounded text-[11px] text-text-muted hover:text-text hover:border-text-muted">
              + Neuer Verwalter
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
