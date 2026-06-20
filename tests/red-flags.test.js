import { describe, it, expect } from 'vitest';
import { scanRedFlags, RED_FLAG_ADVICE } from '../src/red-flags.js';

describe('scanRedFlags — flags serious signals', () => {
  it.each([
    ['acute pain', 'I get a sharp pain in my knee when I push off', 'acute_pain'],
    ['suspected tear', 'I think I tore my hamstring last week', 'suspected_tear'],
    ['nerve symptoms', 'there is numbness down my left leg', 'neuro'],
    ['cardiac', 'I had chest pain during the last rep', 'cardiac'],
    ['head injury', 'I had a concussion two weeks ago', 'head'],
    ['fracture', 'the doctor said it might be a stress fracture', 'bone'],
    ['RED-S', 'I lost my period and have been restricting calories', 'red_s'],
  ])('flags %s', (_label, text, category) => {
    const r = scanRedFlags(text);
    expect(r.flagged).toBe(true);
    expect(r.categories).toContain(category);
    expect(r.advice).toBe(RED_FLAG_ADVICE);
  });

  it('is case-insensitive', () => {
    expect(scanRedFlags('CHEST PAIN right now').flagged).toBe(true);
  });
});

describe('scanRedFlags — avoids false positives', () => {
  it('does not flag a routine niggle', () => {
    const r = scanRedFlags('slightly tight left hamstring, feels a bit sore after sprints');
    expect(r.flagged).toBe(false);
  });

  it('does not flag benign goal text', () => {
    const r = scanRedFlags('I want to run a sub-11 100m, train 5 days a week, full gym access');
    expect(r.flagged).toBe(false);
  });

  it('respects word boundaries (numbness vs number, reds vs tired)', () => {
    expect(scanRedFlags('my goal is a faster number on the clock').flagged).toBe(false);
    expect(scanRedFlags('I am tired and scored a PB').flagged).toBe(false);
  });

  it('treats empty / non-string input as not flagged', () => {
    expect(scanRedFlags('').flagged).toBe(false);
    expect(scanRedFlags(null).flagged).toBe(false);
    expect(scanRedFlags(undefined).flagged).toBe(false);
  });
});
