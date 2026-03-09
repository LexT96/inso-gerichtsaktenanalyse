import { Section } from '../Section';
import type { FehlendInfo } from '../../../types/extraction';

interface FehlendTabProps {
  missingInfo: FehlendInfo[];
}

export function FehlendTab({ missingInfo }: FehlendTabProps) {
  return (
    <Section title="Fehlende Informationen" icon="△" count={missingInfo.length}>
      {missingInfo.length > 0 ? (
        missingInfo.map((m, i) => {
          const title = typeof m === 'string' ? m : (m.information || m.grund || m.ermittlung_ueber || 'Fehlende Angabe').trim();
          const titleFromGrund = typeof m === 'object' && !m.information?.trim() && m.grund?.trim() === title;
          return (
          <div key={i} className="p-2.5 px-3 mb-1.5 bg-ie-red-bg border border-ie-red-border rounded-sm">
            <div className="text-xs text-text font-semibold font-sans">
              {title}
            </div>
            {typeof m === 'object' && m.grund && !titleFromGrund && (
              <div className="text-[10px] text-text-dim mt-0.5">
                Grund: {m.grund}
              </div>
            )}
            {typeof m === 'object' && m.ermittlung_ueber && (
              <div className="text-[10px] text-ie-amber mt-0.5">
                → Ermittlung über: {m.ermittlung_ueber}
              </div>
            )}
          </div>
        );})
      ) : (
        <div className="text-center py-10 text-ie-green text-xs">
          Alle wesentlichen Informationen wurden gefunden.
        </div>
      )}
    </Section>
  );
}
