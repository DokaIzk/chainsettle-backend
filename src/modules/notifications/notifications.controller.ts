import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, NotFoundException, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { NotificationsService } from './notifications.service';
import { WebPushService } from './web-push.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { RegisterWebPushDto } from './dto/register-web-push.dto';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly webPushService: WebPushService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get notifications for the authenticated user' })
  @ApiQuery({ name: 'unreadOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAll(
    @CurrentUser('id') userId: string,
    @Query('unreadOnly') unreadOnly?: boolean,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.notificationsService.findForUser(userId, unreadOnly, page, limit);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  markRead(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.notificationsService.markRead(id, userId);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  markAllRead(@CurrentUser('id') userId: string) {
    return this.notificationsService.markAllRead(userId);
  }

  @Delete('read')
  @ApiOperation({ summary: 'Delete all read notifications for the authenticated user' })
  deleteAllRead(@CurrentUser('id') userId: string) {
    return this.notificationsService.deleteAllRead(userId);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Get notification preferences for the authenticated user' })
  getPreferences(@CurrentUser('id') userId: string) {
    return this.notificationsService.getPreferencesResponse(userId);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Update notification preferences (partial merge)' })
  updatePreferences(@CurrentUser('id') userId: string, @Body() dto: UpdatePreferencesDto) {
    return this.notificationsService.updatePreferences(userId, dto);
  }

  @Post('test')
  @Throttle({ default: { limit: 1, ttl: 5 * 60 * 1000 } })
  @ApiOperation({ summary: 'Send a test notification to yourself' })
  sendTestNotification(@CurrentUser('id') userId: string) {
    return this.notificationsService.sendTestNotification(userId);
  }

  @Get('digest-preview')
  @ApiOperation({ summary: 'Preview the next scheduled email digest' })
  async getDigestPreview(@CurrentUser('id') userId: string) {
    const digest = await this.notificationsService.buildDigest(userId);
    return digest || { subject: '', html: '' };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single notification by ID' })
  async findOne(@Param('id') id: string, @CurrentUser('id') userId: string) {
    const notification = await this.notificationsService.findOne(userId, id);
    if (!notification) throw new NotFoundException('Notification not found');
    return notification;
  }

  // ── Web Push ────────────────────────────────────────────────────────────────

  @Public()
  @Get('web-push/public-key')
  @ApiOperation({ summary: 'Get the VAPID public key for web push subscription' })
  getWebPushPublicKey() {
    const key = this.webPushService.getPublicKey();
    return { publicKey: key };
  }

  @Post('web-push/subscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Register a browser push subscription for the authenticated user' })
  subscribeWebPush(@CurrentUser('id') userId: string, @Body() dto: RegisterWebPushDto) {
    return this.webPushService.subscribe(userId, dto);
  }

  @Delete('web-push/subscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a browser push subscription' })
  unsubscribeWebPush(@CurrentUser('id') userId: string, @Body() dto: RegisterWebPushDto) {
    return this.webPushService.unsubscribe(userId, dto.endpoint);
  }
}
