import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsDefined,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { StoreBillingService } from './store-billing.service';
import type { StorePlatform } from './store-billing.types';
class PlatformDto {
  @IsIn(['APPLE', 'GOOGLE']) platform!: StorePlatform;
}
class VerifyDto extends PlatformDto {
  @IsString() @MinLength(1) @MaxLength(4096) reference!: string;
}
class AppleNotificationDto {
  @IsString() @MinLength(1) @MaxLength(65536) signedPayload!: string;
}
class PubSubMessage {
  @IsString() @MinLength(1) @MaxLength(65536) data!: string;
}
class GoogleNotificationDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => PubSubMessage)
  message!: PubSubMessage;
}
@Controller('store-billing')
export class StoreBillingController {
  constructor(private readonly billing: StoreBillingService) {}
  @UseGuards(JwtAuthGuard)
  @Get('catalog')
  catalog(
    @Req() req: { user: { userId: string } },
    @Query() query: PlatformDto,
  ) {
    return this.billing.catalog(req.user.userId, query.platform);
  }
  @UseGuards(JwtAuthGuard)
  @Post('verify')
  verify(@Req() req: { user: { userId: string } }, @Body() body: VerifyDto) {
    return this.billing.verify(req.user.userId, body.platform, body.reference);
  }
  @Post('notifications/apple')
  apple(@Body() body: AppleNotificationDto) {
    return this.billing.notification('APPLE', body.signedPayload);
  }
  @Post('notifications/google')
  google(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: GoogleNotificationDto,
  ) {
    return this.billing.notification(
      'GOOGLE',
      body.message.data,
      authorization,
    );
  }
}
