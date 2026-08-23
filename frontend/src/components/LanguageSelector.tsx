import { useTranslation } from 'react-i18next';

interface LanguageSelectorProps {
  value: 'vi'|'en';
  onChange: (language: 'vi'|'en') => void;
}

export default function LanguageSelector({
  value,
  onChange,
}: LanguageSelectorProps) {
  const { t }=useTranslation();

  return (
    <div>
      <label htmlFor="tts-language">
        {t('language.label')}
      </label>

      <select
        id="tts-language"
        value={value}
        onChange={(event) =>
          onChange(event.target.value as 'vi'|'en')
        }
      >
        <option value="vi">
          {t('language.vietnamese')}
        </option>

        <option value="en">
          {t('language.english')}
        </option>
      </select>
    </div>
  );
}