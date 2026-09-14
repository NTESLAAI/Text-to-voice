import { characterCountRules } from './character-count';

export function countBillableCharacters(
  text: string,
  language: string = 'vi',
): number {
  const normalizedText = text.normalize('NFC');
  const rule = characterCountRules[language];

  let spokenText = normalizedText;

  if (rule?.expandAbbreviations) {
    const abbreviations = Object.entries(rule.expandAbbreviations)
      .sort(([a], [b]) => b.length - a.length);

    for (const [abbreviation, expansion] of abbreviations) {
      const escaped = abbreviation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      spokenText = spokenText.replace(
        new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'),
        expansion,
      );
    }
  }

  return [...spokenText].filter(
    (char) => /[\p{L}\p{N}]/u.test(char),
  ).length;
}
