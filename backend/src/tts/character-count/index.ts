import type { CharacterCountRule } from './types';
import viCharacterCountRule from './vi';
import enCharacterCountRule from './en';

export const characterCountRules: Record<string, CharacterCountRule> = {
  vi: viCharacterCountRule,
  en: enCharacterCountRule,
};
