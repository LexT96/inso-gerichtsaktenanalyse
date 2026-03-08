import { Section } from '../Section';
import type { FehlendInfo } from '../../../types/extraction';

interface FehlendTabProps {
  missingInfo: FehlendInfo[];
}

export function FehlendTab({ missingInfo }: FehlendTabProps) {
  return (
    <Section title="Fehlende Informationen" icon="△" count={missingInfo.length}>
      {missingInfo.length > 0 ? (
        missingInfo.map((m, i) => (
          <div key={i} className="p-2.5 px-3 mb-1.5 bg-ie-red-bg border border-ie-red-border rounded-sm">
            <div className="text-xs text-text font-semibold font-sans">
              {typeof m === 'string' ? m : m.information || JSON.stringify(m)}
            </div>
            {m.grund && (
              <div className="text-[10px] text-text-dim mt-0.5">
                Grund: {m.grund}
              </div>
            )}
            {m.ermittlung_ueber && (
              <div className="text-[10px] text-ie-amber mt-0.5">
                → Ermittlung über: {m.ermittlung_ueber}
              </div>
            )}
          </div>
        ))
      ) : (
        <div className="text-center py-10 text-ie-green text-xs">
          Alle wesentlichen Informationen wurden gefunden.
        </div>
      )}
    </Section>
  );
}
