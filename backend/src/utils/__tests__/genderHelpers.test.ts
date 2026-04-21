import { describe, it, expect } from 'vitest';
import { schuldnerGender, verwalterGender } from '../genderHelpers';

describe('schuldnerGender', () => {
  it('returns masculine articles for maennlich and männlich', () => {
    expect(schuldnerGender('maennlich', 'der_die')).toBe('der');
    expect(schuldnerGender('maennlich', 'Der_Die')).toBe('Der');
    expect(schuldnerGender('maennlich', 'den_die')).toBe('den');
    expect(schuldnerGender('maennlich', 'dem_der')).toBe('dem');
    expect(schuldnerGender('maennlich', 'nominativ_substantiv')).toBe('Schuldner');
    expect(schuldnerGender('maennlich', 'genitiv_substantiv')).toBe('Schuldners');
    expect(schuldnerGender('maennlich', 'halters_halterin')).toBe('des Halters');
    // umlaut form — extraction pipeline writes 'männlich'
    expect(schuldnerGender('männlich', 'der_die')).toBe('der');
    expect(schuldnerGender('männlich', 'nominativ_substantiv')).toBe('Schuldner');
  });

  it('returns feminine articles for weiblich', () => {
    expect(schuldnerGender('weiblich', 'der_die')).toBe('die');
    expect(schuldnerGender('weiblich', 'Der_Die')).toBe('Die');
    expect(schuldnerGender('weiblich', 'den_die')).toBe('die');
    expect(schuldnerGender('weiblich', 'dem_der')).toBe('der');
    expect(schuldnerGender('weiblich', 'nominativ_substantiv')).toBe('Schuldnerin');
    expect(schuldnerGender('weiblich', 'genitiv_substantiv')).toBe('Schuldnerin');
    expect(schuldnerGender('weiblich', 'halters_halterin')).toBe('der Halterin');
  });

  it('defaults to masculine for null/unknown', () => {
    expect(schuldnerGender(null, 'der_die')).toBe('der');
    expect(schuldnerGender('unknown', 'der_die')).toBe('der');
  });
});

describe('verwalterGender', () => {
  it('returns correct forms for maennlich', () => {
    expect(verwalterGender('maennlich', 'der_die')).toBe('der');
    expect(verwalterGender('maennlich', 'Der_Die')).toBe('Der');
    expect(verwalterGender('maennlich', 'zum_zur')).toBe('zum');
    // umlaut form
    expect(verwalterGender('männlich', 'zum_zur')).toBe('zum');
  });

  it('returns correct forms for weiblich', () => {
    expect(verwalterGender('weiblich', 'der_die')).toBe('die');
    expect(verwalterGender('weiblich', 'Der_Die')).toBe('Die');
    expect(verwalterGender('weiblich', 'zum_zur')).toBe('zur');
  });
});
