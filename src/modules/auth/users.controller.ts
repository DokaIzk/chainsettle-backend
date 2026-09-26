import { Controller, Get, Patch, Post, Body, UseGuards, HttpCode, HttpStatus, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { RevokeAllSessionsDto } from './dto/revoke-all-sessions.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '@prisma/client';

@ApiTags('users')
@Controller('users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UsersController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
    private readonly auditLogs: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Get the authenticated user profile' })
  @ApiResponse({ status: 200, description: 'Returns user profile' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getProfile(@CurrentUser() user: any) {
    return this.authService.getProfile(user.id);
  }

  @Get('me/sessions')
  @ApiOperation({
    summary: 'List active sessions for the authenticated user',
    description:
      'Returns metadata for every device/session currently authenticated against this account. ' +
      'Raw token values are never included — only opaque session IDs and request metadata.',
  })
  @ApiResponse({ status: 200, description: 'Array of active session records' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getSessions(@CurrentUser('id') userId: string) {
    return this.authService.getSessions(userId);
  }

  @Post('me/sessions/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke a single active session for the authenticated user',
    description:
      'Deletes the selected session entry and adds its JWT to the revocation blocklist. ' +
      'This invalidates only that device/session without logging out other active sessions.',
  })
  @ApiResponse({ status: 200, description: 'Session revoked successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  revokeSession(@CurrentUser('id') userId: string, @Param('id') sessionId: string) {
    return this.authService.revokeSession(userId, sessionId);
  }

  @Patch('me')
  @BlockImpersonation()
  @ApiOperation({ summary: 'Update user profile (name, email)' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Blocked during impersonation' })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  updateProfile(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(user.id, dto);
  }

  /**
   * POST /users/me/sessions/revoke-all
   *
   * Revoke every active session for the authenticated user except the
   * current one (unless includeCurrent: true is passed).
   *
   * After this call:
   *  - Tokens from all other devices are added to the Redis blocklist
   *    and will be rejected on their next request.
   *  - The caller's own token continues to work (unless includeCurrent).
   *  - An audit log entry is written.
   *  - A SYSTEM_ALERT notification is sent.
   */
  @Post('me/sessions/revoke-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke all sessions except the current one (sign out of all other devices)' })
  @ApiResponse({ status: 200, description: 'Sessions revoked — returns { revokedCount }' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async revokeAllSessions(
    @CurrentUser() user: any,
    @Body() dto: RevokeAllSessionsDto,
    @Req() req: any,
  ) {
    const currentJti: string = user.jti ?? '';
    const includeCurrent = dto.includeCurrent ?? false;

    const revokedCount = await this.sessionService.revokeAllSessions(
      user.id,
      currentJti,
      includeCurrent,
    );

    // Audit log
    await this.auditLogs.record({
      actorId: user.id,
      actorAddress: user.stellarAddress,
      action: 'session.revoke_all',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { revokedCount, includeCurrent },
      ipAddress: req.ip,
    });

    // In-app + email notification
    await this.notifications.notifyUser(
      user.stellarAddress,
      NotificationType.SYSTEM_ALERT,
      'Security alert: sessions revoked',
      `${revokedCount} active session(s) were signed out${includeCurrent ? ', including your current session' : ''}.`,
      { revokedCount, includeCurrent },
    );

    return { revokedCount };
  }
}
