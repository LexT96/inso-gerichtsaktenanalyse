export type GenderInput = string | null | undefined;

function isWeiblich(g: GenderInput): boolean {
  if (!g) return false;
  const s = g.toLowerCase();
  return s === 'weiblich' || s === 'w' || s === 'female' || s === 'f';
}

// Explicit positive recognizer for masculine so that future non-binary
// extensions can distinguish "known masculine" from "unknown/null".
// The main path still uses isWeiblich as the sole gate — both explicit
// masculine and unknown/null default to masculine output.
function isMaennlich(g: GenderInput): boolean {
  if (!g) return false;
  const s = g.toLowerCase();
  return s === 'maennlich' || s === 'männlich' || s === 'm' || s === 'male';
}

export type SchuldnerVariant =
  | 'der_die'
  | 'Der_Die'
  | 'den_die'
  | 'dem_der'
  | 'nominativ_substantiv'
  | 'genitiv_substantiv'
  | 'halters_halterin';

export function schuldnerGender(g: GenderInput, variant: SchuldnerVariant): string {
  const w = isWeiblich(g);
  switch (variant) {
    case 'der_die': return w ? 'die' : 'der';
    case 'Der_Die': return w ? 'Die' : 'Der';
    case 'den_die': return w ? 'die' : 'den';
    case 'dem_der': return w ? 'der' : 'dem';
    case 'nominativ_substantiv': return w ? 'Schuldnerin' : 'Schuldner';
    case 'genitiv_substantiv': return w ? 'Schuldnerin' : 'Schuldners';
    case 'halters_halterin': return w ? 'der Halterin' : 'des Halters';
  }
}

export type VerwalterVariant = 'der_die' | 'Der_Die' | 'zum_zur';

export function verwalterGender(g: GenderInput, variant: VerwalterVariant): string {
  const w = isWeiblich(g);
  switch (variant) {
    case 'der_die': return w ? 'die' : 'der';
    case 'Der_Die': return w ? 'Die' : 'Der';
    case 'zum_zur': return w ? 'zur' : 'zum';
  }
}
