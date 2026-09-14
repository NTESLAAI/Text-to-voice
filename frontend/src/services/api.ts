import axios from 'axios';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { countBillableCharacters } from '../utils/characterCount';
import { getAuthToken } from './authStorage';

const API_BASE_URL=import.meta.env.VITE_API_BASE_URL;

const api=axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use(async (config) => {
  const token=await getAuthToken();

  if (token) {
    config.headers.Authorization=`Bearer ${token}`;
  }

  return config;
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
export interface DialogueRecord {
  id: string;
  projectId: string;
  language: 'vi'|'en';
  fileUrl: string;
  format: string;
  characters: number;
  duration: number;
  provider: string;
  model: string;
  createdAt: string;
  speakers: Array<{
    id: string;
    dialogueId: string;
    role: 'A'|'B';
    gender: 'male'|'female';
    age: string;
    character: string;
    region: string;
  }>;
  turns: Array<{
    id: string;
    dialogueId: string;
    order: number;
    speaker: 'A'|'B';
    text: string;
    style: string;
  }>;
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
  |'cinematic'
  |'poetry';

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

export interface SynthesizeDialogueRequest {
  projectId: string;
  language: 'vi'|'en';
  speakerA: {
    gender: 'male'|'female';
    character: SynthesizeSpeechRequest['character'];
    region: 'north_vietnam'|'central_vietnam'|'south_vietnam';
  };
  speakerB: {
    gender: 'male'|'female';
    character: SynthesizeSpeechRequest['character'];
    region: 'north_vietnam'|'central_vietnam'|'south_vietnam';
  };
  turns: Array<{
    speaker: 'A'|'B';
    text: string;
    style: SynthesizeSpeechRequest['style'];
  }>;
  speed: number;
}

export interface SynthesizeDialogueResult {
  fileUrl: string;
}

export async function synthesizeSpeech(
  request: SynthesizeSpeechRequest,
): Promise<SynthesizeSpeechResult> {
  try {
    console.log('TTS REQUEST:', request);

    let audioBlob: Blob;

    if (Capacitor.getPlatform()==='android') {
      const response=await CapacitorHttp.post({
        url: `${API_BASE_URL}/tts/synthesize`,
        headers: {
          'Content-Type': 'application/json',
        },
        data: request,
        responseType: 'blob',
      });

      const binaryString=atob(response.data as string);
      const bytes=new Uint8Array(binaryString.length);

      for (let i=0;i<binaryString.length;i++) {
        bytes[i]=binaryString.charCodeAt(i);
      }

      audioBlob=new Blob([bytes], {
        type: 'audio/wav',
      });
    } else {
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

      audioBlob=response.data as Blob;
    }

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
      characters: countBillableCharacters(request.text, request.language),
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

export async function synthesizeDialogue(
  request: SynthesizeDialogueRequest,
): Promise<SynthesizeDialogueResult> {
  let audioBlob: Blob;

  if (Capacitor.getPlatform()==='android') {
    const response=await CapacitorHttp.post({
      url: `${API_BASE_URL}/tts/dialogue`,
      headers: {
        'Content-Type': 'application/json',
      },
      data: request,
      responseType: 'blob',
    });

    const binaryString=atob(response.data as string);
    const bytes=new Uint8Array(binaryString.length);

    for (let i=0;i<binaryString.length;i++) {
      bytes[i]=binaryString.charCodeAt(i);
    }

    audioBlob=new Blob([bytes], {
      type: 'audio/wav',
    });
  } else {
    const response=await api.post(
      '/tts/dialogue',
      request,
      {
        responseType: 'blob',
      },
    );

    audioBlob=response.data as Blob;
  }

  return {
    fileUrl: URL.createObjectURL(audioBlob),
  };
}

export async function getProjectAudio(
  projectId: string,
): Promise<AudioRecord[]> {
  const response=await api.get<AudioRecord[]>(
    `/audio/project/${projectId}`,
  );

  return response.data;
}
export async function getProjectDialogues(
  projectId: string,
): Promise<DialogueRecord[]> {
  const response=await api.get<DialogueRecord[]>(
    `/tts/dialogue/project/${projectId}`,
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

export interface ProjectUsage {
  plan: string;
  characterLimit: number;
  usedCharacters: number;
  remainingCharacters: number;
}

export async function getProjectUsage(
  projectId: string,
): Promise<ProjectUsage> {
  const response=await api.get<ProjectUsage>(
    `/tts/usage/project/${projectId}`,
  );

  return response.data;
}

export interface AuthUser {
  id: string;
  email: string;
  name?: string|null;
}

export interface LoginResult {
  message: string;
  accessToken: string;
  user: AuthUser;
}

export async function login(
  email: string,
  password: string,
): Promise<LoginResult> {
  const response=await api.post<LoginResult>(
    '/auth/login',
    {
      email,
      password,
    },
  );

  return response.data;
}
export async function getMyProject() {
  const response=await api.get('/projects/me');
  return response.data;
}
export default api;
