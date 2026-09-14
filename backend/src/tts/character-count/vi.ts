import type { CharacterCountRule } from './types';

const viCharacterCountRule: CharacterCountRule = {
  expandAbbreviations: {
    'v.v': 'vân vân',
    'v.v.': 'vân vân',
  },
};

export default viCharacterCountRule;
