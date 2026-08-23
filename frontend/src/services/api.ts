import axios from 'axios';

const API_BASE_URL=import.meta.env.VITE_API_BASE_URL;

const api=axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

export interface AudioRecord {
  id: string;
  projectId: string;
  text: string;
  language: 'vi'|'en';
  voice: string;
  speed: number;
  provider: string;
  model: string;
  fileUrl: string;
  format: string;
  characters: number;
  duration: number;
  cost?: number|null;
  createdAt: string;
}

export interface VoicePreset {
  id: string;
  label: string;
  description: string;
  region: string;
  character: string;
  tone: string;
  emotion: string;
  style: string;
  speed: number;
}

export async function getVoicePresets(): Promise<VoicePreset[]> {
  const response=await api.get('/tts/presets');

  return response.data;
}

export interface SynthesizeSpeechRequest {
  projectId: string;
  text: string;
  language: 'vi'|'en';

  preset?: string;

  region:
  |'north_vietnam'
  |'central_vietnam'
  |'south_vietnam'
  |'standard_vietnamese'
  |'american_english'
  |'british_english';

  character:
  |'young_male'
  |'young_female'
  |'adult_male'
  |'adult_female'
  |'elderly_male'
  |'elderly_female'
  |'boy'
  |'girl';

  tone:
  |'deep'
  |'neutral'
  |'high';

  emotion:
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

  style:
  |'conversation'
  |'storytelling'
  |'night_storytelling'
  |'presenter'
  |'lecture'
  |'news'
  |'podcast'
  |'advertising'
  |'cinematic';

  speed: number;
}

export interface SynthesizeSpeechResult {
  id: string;
  projectId: string;
  text: string;
  language: 'vi'|'en';

  voice: string;
  character: string;
  tone: string;
  emotion: string;
  style: string;
  speed: number;

  provider: string;
  model: string;
  fileUrl: string;
  format: string;
  characters: number;
  duration: number;
}

export async function synthesizeSpeech(
  request: SynthesizeSpeechRequest,
): Promise<SynthesizeSpeechResult> {
  try {
    console.log('TTS REQUEST:', request);

    const response=await api.post(
      '/tts/synthesize',
      request,
      {
        responseType: 'blob',
      },
    );

    console.log(
      'TTS RESPONSE:',
      response.status,
      response.headers,
    );

    const audioBlob=response.data as Blob;

    const audioUrl=URL.createObjectURL(audioBlob);

    return {
      id: '',
      projectId: request.projectId,
      text: request.text,
      language: request.language,
      character: request.character,
      tone: request.tone,
      emotion: request.emotion,
      style: request.style,
      voice: 'Zephyr',
      speed: request.speed,
      provider: 'openrouter',
      model: 'google/gemini-3.1-flash-tts-preview',
      fileUrl: audioUrl,
      format: 'wav',
      characters: request.text.length,
      duration: 0,
    };
  } catch (error) {
    console.error('TTS ERROR:', error);

    const axiosError=error as any;
    const errorData=axiosError.response?.data;

    if (errorData instanceof Blob) {
      const errorText=await errorData.text();

      console.error('TTS ERROR RESPONSE:', errorText);
    } else {
      console.error('TTS ERROR RESPONSE:', errorData);
    }

    throw error;
  }
}

export async function getProjectAudio(
  projectId: string,
): Promise<AudioRecord[]> {
  const response=await api.get<AudioRecord[]>(
    `/audio/project/${projectId}`,
  );

  return response.data;
}

export async function deleteAudio(
  id: string,
): Promise<void> {
  await api.delete(`/audio/${id}`);
}

export function getAudioUrl(
  fileUrl: string,
): string {
  if (
    fileUrl.startsWith('http://')||
    fileUrl.startsWith('https://')||
    fileUrl.startsWith('blob:')
  ) {
    return fileUrl;
  }

  return `${API_BASE_URL}${fileUrl}`;
}

export interface TextReviewResult {
  hasErrors: boolean;
  errors: string[];
  suggestion: string;
  correctedText: string;
}

export async function reviewText(
  text: string,
): Promise<TextReviewResult> {
  const response=await api.post<TextReviewResult>(
    '/text-review',
    {
      text,
    },
  );

  return response.data;
}

export default api;
