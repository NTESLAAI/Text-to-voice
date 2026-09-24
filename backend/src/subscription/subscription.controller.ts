import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { SubscriptionService } from './subscription.service';
import { UpgradeSubscriptionDto } from './dto/upgrade-subscription.dto';

@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMySubscription(@Req() req: any) {
    return this.subscriptionService.getMySubscription(req.user.userId);
  }
  @UseGuards(JwtAuthGuard)
  @Post('upgrade')
  upgradeSubscription(@Req() req: any, @Body() body: UpgradeSubscriptionDto) {
    return this.subscriptionService.upgradeSubscription(
      req.user.userId,
      body.planCode,
    );
  }
}
