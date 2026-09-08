import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import type {
  VoiceCharacter,
  VoiceRegion,
  VoiceStyle,
} from '../config/voice-profiles';

const VOICE_CHARACTERS: VoiceCharacter[]=[
  'young_male',
  'young_female',
  'adult_male',
  'adult_female',
  'elderly_male',
  'elderly_female',
  'boy',
  'girl',
];

const VOICE_REGIONS: VoiceRegion[]=[
  'north_vietnam',
  'central_vietnam',
  'south_vietnam',
  'standard_vietnamese',
  'american_english',
  'british_english',
];

const VOICE_STYLES: VoiceStyle[]=[
  'conversation',
  'storytelling',
  'night_storytelling',
  'presenter',
  'lecture',
  'news',
  'podcast',
  'advertising',
  'cinematic',
  'poetry',
];

export class DialogueSpeakerDto {
  @IsIn(['male', 'female'])
  gender!: 'male'|'female';

  @IsIn(VOICE_CHARACTERS)
  character!: VoiceCharacter;

  @IsIn(VOICE_REGIONS)
  region!: VoiceRegion;
}

export class DialogueTurnDto {
  @IsIn(['A', 'B'])
  speaker!: 'A'|'B';

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  text!: string;

  @IsIn(VOICE_STYLES)
  style!: VoiceStyle;
}

export class SynthesizeDialogueDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsIn(['vi', 'en'])
  language!: 'vi'|'en';

  @ValidateNested()
  @Type(() => DialogueSpeakerDto)
  speakerA!: DialogueSpeakerDto;

  @ValidateNested()
  @Type(() => DialogueSpeakerDto)
  speakerB!: DialogueSpeakerDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => DialogueTurnDto)
  turns!: DialogueTurnDto[];

  @IsOptional()
  @IsNumber()
  @Min(0.7)
  @Max(1.5)
  speed!: number;
}
