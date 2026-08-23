import {
  VoiceCharacter,
  VoiceEmotion,
  VoiceRegion,
  VoiceStyle,
  VoiceTone,
  VOICE_EMOTIONS,
  VOICE_PROFILES,
  VOICE_PRESETS,
  VOICE_REGIONS,
  VOICE_STYLES,
  VOICE_TONES,
} from './config/voice-profiles';

export interface VoiceDirectorOptions {
  character: VoiceCharacter;
  region: VoiceRegion;
  tone: VoiceTone;
  emotion: VoiceEmotion;
  style: VoiceStyle;
  speed: number;
  language: string;
}

export interface VoiceDirection {
  instruction: string;
  character: string;
  region: VoiceRegion;
  tone: VoiceTone;
  emotion: VoiceEmotion;
  style: VoiceStyle;
  speed: number;
  language: string;
}

export class VoiceDirectorService {
  createDirection(
    options: VoiceDirectorOptions,
  ): VoiceDirection {
    const profile=
      VOICE_PROFILES[options.character];

    if (!profile) {
      throw new Error(
        `Unknown voice character: ${options.character}`,
      );
    }

    const tone=
      VOICE_TONES[options.tone];

    const emotion=
      VOICE_EMOTIONS[options.emotion];

    const style=
      VOICE_STYLES[options.style];

    const region=
      VOICE_REGIONS[options.region];

    const genderInstruction=
      profile.gender==='male'
        ? 'Use a clearly male adult human voice. The speaker must sound distinctly masculine, not female. Use a natural masculine vocal range and vocal character. Do not use a female voice.'
        :'Use a clearly female adult human voice. The speaker must sound distinctly feminine, not male. Use a natural feminine vocal range and vocal character. Do not use a male voice.';

    const ageInstruction=
      options.character==='boy'
        ? 'Use a clearly young child male voice, approximately 7 to 10 years old. Keep the voice consistently childlike throughout the entire speech, with a naturally higher pitch, smaller vocal resonance, youthful pronunciation and innocent childlike character. Do not sound like an adult male.'
        :options.character==='girl'
          ? 'Use a clearly young child female voice, approximately 7 to 10 years old. Keep the voice consistently childlike throughout the entire speech, with a naturally higher pitch, smaller vocal resonance, youthful pronunciation and innocent childlike character. Do not sound like an adult female.'
          :'';

    const instruction=[
      `Speak naturally in ${options.language}.`,
      genderInstruction,
      ageInstruction,
      `Use the vocal character of ${profile.character}.`,
      profile.description,
      region,
      tone,
      emotion,
      style,
      'Use natural pauses, realistic rhythm and varied intonation.',
      'Avoid sounding robotic, mechanical or monotonous.',
      'Do not exaggerate the character or emotion.',
      `Speak at approximately ${options.speed}x normal pace.`,
    ].join(' ');

    return {
      instruction,
      character: profile.character,
      region: options.region,
      tone: options.tone,
      emotion: options.emotion,
      style: options.style,
      speed: options.speed,
      language: options.language,
    };
  }
  getPreset(presetId: string) {
    return VOICE_PRESETS[presetId];
  }
}