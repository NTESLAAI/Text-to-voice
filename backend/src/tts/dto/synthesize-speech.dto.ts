import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import type {
  VoiceCharacter,
  VoiceEmotion,
  VoiceRegion,
  VoiceStyle,
  VoiceTone,
} from '../config/voice-profiles';

export class SynthesizeSpeechDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  text!: string;

  @IsIn(['vi', 'en'])
  language!: 'vi' | 'en';

      @IsOptional()
  @IsString()
  preset?: string;
  
    @IsIn([
    'north_vietnam',
    'central_vietnam',
    'south_vietnam',
    'standard_vietnamese',
    'american_english',
    'british_english',
  ])
  region!: VoiceRegion;

  @IsIn([
    'young_male',
    'young_female',
    'adult_male',
    'adult_female',
    'elderly_male',
    'elderly_female',
    'boy',
    'girl',
  ])
  character!: VoiceCharacter;

  @IsIn([
    'deep',
    'neutral',
    'high',
  ])
  tone!: VoiceTone;

  @IsIn([
    'natural',
    'happy',
    'sad',
    'warm',
    'excited',
    'formal',
    'angry',
    'worried',
    'fearful',
    'whisper',
  ])
  emotion!: VoiceEmotion;

  @IsIn([
  'conversation',
  'storytelling',
  'night_storytelling',
  'presenter',
  'lecture',
  'news',
  'podcast',
  'advertising',
  'cinematic',
])
style!: VoiceStyle;

  @IsNumber()
  @Min(0.7)
  @Max(1.5)
  speed!: number;
}