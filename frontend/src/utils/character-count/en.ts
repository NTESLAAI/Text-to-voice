import type { CharacterCountRule } from './types';

const enCharacterCountRule: CharacterCountRule = {
  expandAbbreviations: {
    'etc.': 'etcetera',
    'vs.': 'versus',
    'Mr.': 'Mister',
    'Mrs.': 'Misses',
    'Dr.': 'Doctor',
  },
};

export default enCharacterCountRule;
