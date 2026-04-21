import { useState } from 'react';

interface Props {
  typ: string;
  onCancel: () => void;
  onSubmit: (extras: Record<string, string>) => void;
}

export function StrafakteInputsModal({ typ, onCancel, onSubmit }: Props) {
  const [person, setPerson] = useState('');
  const [tatvorwurf, setTatvorwurf] = useState('');
  const [gegenstand, setGegenstand] = useState('');

  const allFilled = Boolean(
    person.trim() && tatvorwurf.trim() && gegenstand.trim(),
  );

  function submit() {
    onSubmit({
      strafverfahren_person: person.trim(),
      strafverfahren_tatvorwurf: tatvorwurf.trim(),
      strafverfahren_gegenstand: gegenstand.trim(),
    });
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-lg w-full p-5">
        <h3 className="text-sm font-semibold mb-1">{typ}: zusätzliche Angaben</h3>
        <p className="text-[11px] text-text-dim mb-4">
          Drei Freitextfelder, die im Brief eingefügt werden. Alle Pflicht.
        </p>
        <label className="block text-[11px] font-medium mb-1">Angeklagte Person</label>
        <input
          type="text"
          value={person}
          onChange={(e) => setPerson(e.target.value)}
          placeholder="z.B. den Geschäftsführer Max Mustermann"
          className="w-full border border-border rounded px-2 py-1 mb-3 text-xs"
        />
        <label className="block text-[11px] font-medium mb-1">Tatvorwurf</label>
        <input
          type="text"
          value={tatvorwurf}
          onChange={(e) => setTatvorwurf(e.target.value)}
          placeholder="z.B. des Betrugs / der Untreue"
          className="w-full border border-border rounded px-2 py-1 mb-3 text-xs"
        />
        <label className="block text-[11px] font-medium mb-1">Erwartete Informationen</label>
        <textarea
          value={gegenstand}
          onChange={(e) => setGegenstand(e.target.value)}
          rows={3}
          placeholder="z.B. Zahlungsströme, Pflichtverletzungen, wirtschaftliche Verhältnisse"
          className="w-full border border-border rounded px-2 py-1 mb-4 text-xs"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-surface-hover"
          >
            Abbrechen
          </button>
          <button
            type="button"
            disabled={!allFilled}
            onClick={submit}
            className="text-xs px-3 py-1.5 rounded bg-ie-green text-white disabled:opacity-40"
          >
            Brief erzeugen
          </button>
        </div>
      </div>
    </div>
  );
}
