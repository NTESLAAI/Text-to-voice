export type VoiceCharacter=
  |'young_male'
  |'young_female'
  |'adult_male'
  |'adult_female'
  |'elderly_male'
  |'elderly_female'
  |'boy'
  |'girl';

export type VoiceRegion=
  |'north_vietnam'
  |'central_vietnam'
  |'south_vietnam'
  |'standard_vietnamese'
  |'american_english'
  |'british_english';

export type VoiceTone=
  |'deep'
  |'neutral'
  |'high';

export type VoiceEmotion=
  |'natural'
  |'happy'
  |'sad'
  |'warm'
  |'excited'
  |'formal'
  |'angry'
  |'worried'
  |'fearful'
  |'whisper';

export type VoiceStyle=
  |'conversation'
  |'storytelling'
  |'night_storytelling'
  |'presenter'
  |'lecture'
  |'news'
  |'podcast'
  |'advertising'
  |'cinematic'
  |'poetry';

export interface VoiceProfile {
  label: string;
  character: string;
  gender: 'male'|'female';
  age: 'child'|'young'|'adult'|'elderly';
  description: string;
}

export interface VoicePreset {
  label: string;
  description: string;

  region: VoiceRegion;
  character: VoiceCharacter;
  tone: VoiceTone;
  emotion: VoiceEmotion;
  style: VoiceStyle;
  speed: number;
}

export const VOICE_PROFILES: Record<
  VoiceCharacter,
  VoiceProfile
>={
  young_male: {
    label: 'Young Male',
    character: 'young male',
    gender: 'male',
    age: 'young',
    description:
      'A natural young adult male voice.',
  },

  young_female: {
    label: 'Young Female',
    character: 'young female',
    gender: 'female',
    age: 'young',
    description:
      'A natural young adult female voice.',
  },

  adult_male: {
    label: 'Adult Male',
    character: 'adult male',
    gender: 'male',
    age: 'adult',
    description:
      'A natural mature adult male voice.',
  },

  adult_female: {
    label: 'Adult Female',
    character: 'adult female',
    gender: 'female',
    age: 'adult',
    description:
      'A natural mature adult female voice.',
  },

  elderly_male: {
    label: 'Elderly Male',
    character: 'elderly male',
    gender: 'male',
    age: 'elderly',
    description:
      'A natural elderly male voice with mature character.',
  },

  elderly_female: {
    label: 'Elderly Female',
    character: 'elderly female',
    gender: 'female',
    age: 'elderly',
    description:
      'A natural elderly female voice with mature character.',
  },

  boy: {
    label: 'Boy',
    character: 'young boy',
    gender: 'male',
    age: 'child',
    description:
      'A natural young boy voice.',
  },

  girl: {
    label: 'Girl',
    character: 'young girl',
    gender: 'female',
    age: 'child',
    description:
      'A natural young girl voice.',
  },
};

export const VOICE_TONES: Record<
  VoiceTone,
  string
>={
  deep:
    'Use a deeper, lower-pitched and resonant vocal tone.',
  neutral:
    'Use a natural, balanced and neutral vocal tone.',
  high:
    'Use a brighter, higher-pitched and lighter vocal tone.',
};

export const VOICE_REGIONS: Record<
  VoiceRegion,
  string
>={
  north_vietnam:
    'Speak Vietnamese with a natural Northern Vietnamese accent and pronunciation.',

  central_vietnam:
    'Speak Vietnamese using a clearly recognizable natural Central Vietnamese accent. Prioritize Central Vietnamese pronunciation and regional intonation over voice character or storytelling style. Do not use Northern or Southern Vietnamese pronunciation. Keep the accent natural and conversational, not exaggerated or caricatured.',

  south_vietnam:
    'Speak Vietnamese with a natural Southern Vietnamese accent and pronunciation.',

  standard_vietnamese:
    'Speak Vietnamese with clear, natural and widely understandable Vietnamese pronunciation.',

  american_english:
    'Speak English with a natural American English accent.',

  british_english:
    'Speak English with a natural British English accent.',
};

export const VOICE_EMOTIONS: Record<
  VoiceEmotion,
  string
>={
  natural:
    'Speak naturally with subtle emotional variation.',
  happy:
    'Sound genuinely happy, friendly and positive.',
  sad:
    'Sound naturally sad and emotionally restrained.',
  warm:
    'Use a warm, gentle and affectionate emotional tone.',
  excited:
    'Sound energetic, enthusiastic and genuinely excited.',
  formal:
    'Use a formal, composed and professional delivery.',
  angry:
    'Express controlled anger with natural intensity.',
  worried:
    'Sound concerned, anxious and emotionally involved.',
  fearful:
    'Express natural fear and nervousness without exaggeration.',
  whisper:
    'Speak softly and intimately, like a natural whisper.',
};

export const VOICE_STYLES: Record<
  VoiceStyle,
  string
>={
  conversation:
    'Use natural conversational delivery with realistic pauses.',
  storytelling:
    'Use expressive storytelling with natural pacing and varied intonation.',

  lecture:
    'Use clear, structured and engaging educational delivery.',
  news:
    'Use a clear, confident and professional news-reading style.',
  podcast:
    'Use relaxed, intimate and conversational podcast delivery.',
  advertising:
    'Use energetic, persuasive and engaging commercial delivery.',
  cinematic:
    'Use expressive cinematic narration with dramatic but natural delivery.',
  night_storytelling:
    'Tell the story in a calm, slow, intimate and warm late-night storytelling style, with gentle pacing, soft pauses, a soothing relaxed mood and subtle emotional variation.',
  poetry:
    'Read Vietnamese poetry with its natural rhythm, pausing between lines and stanzas. Use expressive phrasing, gentle emphasis and appropriate emotion; do not deliver it with flat prose-like pacing.',

  presenter:
    'Use a confident, clear and engaging presenter delivery with natural energy, expressive intonation and well-timed pauses.',
};

export const VOICE_PRESETS: Record<
  string,
  VoicePreset
>={
  north_female_storytelling: {
    label: 'Nữ miền Bắc – Kể chuyện',
    description:
      'Giọng nữ miền Bắc trưởng thành, ấm áp và tự nhiên, phù hợp kể chuyện.',
    region: 'north_vietnam',
    character: 'adult_female',
    tone: 'neutral',
    emotion: 'warm',
    style: 'storytelling',
    speed: 0.9,
  },

  south_female_storytelling: {
    label: 'Nữ miền Nam – Kể chuyện',
    description:
      'Giọng nữ miền Nam trưởng thành, gần gũi và ấm áp, phù hợp kể chuyện.',
    region: 'south_vietnam',
    character: 'adult_female',
    tone: 'neutral',
    emotion: 'warm',
    style: 'storytelling',
    speed: 0.9,
  },

  central_female_storytelling: {
    label: 'Nữ miền Trung – Kể chuyện',
    description:
      'Giọng nữ miền Trung trưởng thành, tự nhiên và giàu cảm xúc, phù hợp kể chuyện.',
    region: 'central_vietnam',
    character: 'adult_female',
    tone: 'neutral',
    emotion: 'warm',
    style: 'storytelling',
    speed: 0.9,
  },

  south_female_night_storytelling: {
    label: 'Nữ miền Nam – Kể chuyện đêm',
    description:
      'Giọng nữ miền Nam ấm áp, nhẹ nhàng và gần gũi cho những câu chuyện ban đêm.',
    region: 'south_vietnam',
    character: 'adult_female',
    tone: 'neutral',
    emotion: 'warm',
    style: 'night_storytelling',
    speed: 0.85,
  },

  north_female_presenter: {
    label: 'Nữ miền Bắc – Dẫn chương trình',
    description:
      'Giọng nữ miền Bắc trẻ, rõ ràng và năng lượng, phù hợp dẫn chương trình.',
    region: 'north_vietnam',
    character: 'young_female',
    tone: 'neutral',
    emotion: 'excited',
    style: 'presenter',
    speed: 1.0,
  },

  south_female_podcast: {
    label: 'Nữ miền Nam – Podcast',
    description:
      'Giọng nữ miền Nam thân mật, tự nhiên và gần gũi cho podcast.',
    region: 'south_vietnam',
    character: 'adult_female',
    tone: 'neutral',
    emotion: 'warm',
    style: 'podcast',
    speed: 0.95,
  },

  north_female_lecture: {
    label: 'Nữ miền Bắc – Giảng bài',
    description:
      'Giọng nữ miền Bắc rõ ràng, điềm đạm và chuyên nghiệp cho nội dung giáo dục.',
    region: 'north_vietnam',
    character: 'adult_female',
    tone: 'neutral',
    emotion: 'natural',
    style: 'lecture',
    speed: 0.9,
  },

  north_female_news: {
    label: 'Nữ miền Bắc – Tin tức',
    description:
      'Giọng nữ miền Bắc rõ ràng, chắc và chuyên nghiệp cho bản tin.',
    region: 'north_vietnam',
    character: 'adult_female',
    tone: 'neutral',
    emotion: 'formal',
    style: 'news',
    speed: 1.0,
  },

  south_female_excited: {
    label: 'Nữ miền Nam – Sôi nổi',
    description:
      'Giọng nữ miền Nam trẻ trung, vui vẻ và nhiều năng lượng.',
    region: 'south_vietnam',
    character: 'young_female',
    tone: 'neutral',
    emotion: 'excited',
    style: 'conversation',
    speed: 1.0,
  },

  north_female_cinematic: {
    label: 'Nữ miền Bắc – Điện ảnh',
    description:
      'Giọng nữ miền Bắc giàu cảm xúc, phù hợp lời dẫn điện ảnh.',
    region: 'north_vietnam',
    character: 'adult_female',
    tone: 'deep',
    emotion: 'warm',
    style: 'cinematic',
    speed: 0.9,
  },

  north_male_storytelling: {
    label: 'Nam miền Bắc – Kể chuyện',
    description:
      'Giọng nam miền Bắc trưởng thành, ấm áp và tự nhiên, phù hợp kể chuyện.',
    region: 'north_vietnam',
    character: 'adult_male',
    tone: 'neutral',
    emotion: 'warm',
    style: 'storytelling',
    speed: 0.9,
  },

  central_male_storytelling: {
    label: 'Nam miền Trung – Kể chuyện',
    description:
      'Giọng nam miền Trung trưởng thành, tự nhiên và giàu cảm xúc, phù hợp kể chuyện.',
    region: 'central_vietnam',
    character: 'adult_male',
    tone: 'neutral',
    emotion: 'warm',
    style: 'storytelling',
    speed: 0.9,
  },

  south_male_storytelling: {
    label: 'Nam miền Nam – Kể chuyện',
    description:
      'Giọng nam miền Nam trưởng thành, gần gũi và ấm áp, phù hợp kể chuyện.',
    region: 'south_vietnam',
    character: 'adult_male',
    tone: 'neutral',
    emotion: 'warm',
    style: 'storytelling',
    speed: 0.9,
  },

  boy_storytelling: {
    label: 'Bé trai – Kể chuyện',
    description:
      'Giọng bé trai tự nhiên, trong sáng và vui tươi, phù hợp kể chuyện.',
    region: 'standard_vietnamese',
    character: 'boy',
    tone: 'high',
    emotion: 'natural',
    style: 'storytelling',
    speed: 0.95,
  },

  north_boy_storytelling: {
    label: 'Bé trai miền Bắc – Kể chuyện',
    description:
      'Giọng bé trai tự nhiên, trong sáng, với phát âm miền Bắc, phù hợp kể chuyện.',
    region: 'north_vietnam',
    character: 'boy',
    tone: 'high',
    emotion: 'natural',
    style: 'storytelling',
    speed: 0.95,
  },

  central_boy_storytelling: {
    label: 'Bé trai miền Trung – Kể chuyện',
    description:
      'Giọng bé trai tự nhiên, trong sáng, với phát âm miền Trung, phù hợp kể chuyện.',
    region: 'central_vietnam',
    character: 'boy',
    tone: 'high',
    emotion: 'natural',
    style: 'storytelling',
    speed: 0.95,
  },

  south_boy_storytelling: {
    label: 'Bé trai miền Nam – Kể chuyện',
    description:
      'Giọng bé trai tự nhiên, trong sáng, với phát âm miền Nam, phù hợp kể chuyện.',
    region: 'south_vietnam',
    character: 'boy',
    tone: 'high',
    emotion: 'natural',
    style: 'storytelling',
    speed: 0.95,
  },

  girl_storytelling: {
    label: 'Bé gái – Kể chuyện',
    description:
      'Giọng bé gái tự nhiên, trong sáng và nhẹ nhàng, phù hợp kể chuyện.',
    region: 'standard_vietnamese',
    character: 'girl',
    tone: 'high',
    emotion: 'natural',
    style: 'storytelling',
    speed: 0.95,
  },

  north_girl_storytelling: {
    label: 'Bé gái miền Bắc – Kể chuyện',
    description:
      'Giọng bé gái tự nhiên, trong sáng, với phát âm miền Bắc, phù hợp kể chuyện.',
    region: 'north_vietnam',
    character: 'girl',
    tone: 'high',
    emotion: 'natural',
    style: 'storytelling',
    speed: 0.95,
  },

  central_girl_storytelling: {
    label: 'Bé gái miền Trung – Kể chuyện',
    description:
      'Giọng bé gái tự nhiên, trong sáng, với phát âm miền Trung, phù hợp kể chuyện.',
    region: 'central_vietnam',
    character: 'girl',
    tone: 'high',
    emotion: 'natural',
    style: 'storytelling',
    speed: 0.95,
  },

  south_girl_storytelling: {
    label: 'Bé gái miền Nam – Kể chuyện',
    description:
      'Giọng bé gái tự nhiên, trong sáng, với phát âm miền Nam, phù hợp kể chuyện.',
    region: 'south_vietnam',
    character: 'girl',
    tone: 'high',
    emotion: 'natural',
    style: 'storytelling',
    speed: 0.95,
  },

};
