import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PromotionPlanPriceDto {
  @IsString()
  @MinLength(1)
  planId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  promotionalPrice!: number;
}

export class CreatePromotionDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsString()
  @MinLength(1)
  message!: string;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PromotionPlanPriceDto)
  planPrices!: PromotionPlanPriceDto[];
}
