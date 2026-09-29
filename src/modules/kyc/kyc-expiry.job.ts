import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KycStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogService } from '../audit-logs/audit-log.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * KycExpiryJob
 *
 * Runs daily to enforce periodic KYC re-verification (#429):
 *   - reminds VERIFIED users 30 days and 7 days before `kycExpiresAt`
 *     (each reminder is stamped so it is sent exactly once per expiry)
 *   - flips users whose verification has lapsed back to UNVERIFIED
 */
@Injectable()
export class KycExpiryJob {
  private readonly logger = new Logger(KycExpiryJob.name);

  static readonly REMINDERS = [
    { days: 30, field: 'kycReminder30dSentAt' as const },
    { days: 7, field: 'kycReminder7dSentAt' as const },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async run(): Promise<{ reminded: number; expired: number }> {
    try {
      const reminded = await this.sendReminders();
      const expired = await this.expireLapsed();
      this.logger.log(`KYC expiry check complete — ${reminded} reminder(s), ${expired} expiration(s)`);
      return { reminded, expired };
    } catch (error) {
      this.logger.error('KYC expiry job failed', (error as Error).stack);
      return { reminded: 0, expired: 0 };
    }
  }

  async sendReminders(now: Date = new Date()): Promise<number> {
    let sent = 0;
    // Longest window first so a user inside both windows only gets the most
    // urgent reminder on a given run once the 30-day one has gone out.
    for (const { days, field } of KycExpiryJob.REMINDERS) {
      const users = await this.prisma.user.findMany({
        where: {
          kycStatus: KycStatus.VERIFIED,
          [field]: null,
          kycExpiresAt: { gt: now, lte: new Date(now.getTime() + days * DAY_MS) },
        },
        select: { id: true, stellarAddress: true, kycExpiresAt: true },
      });

      for (const user of users) {
        const daysLeft = Math.max(1, Math.ceil((user.kycExpiresAt!.getTime() - now.getTime()) / DAY_MS));
        await this.notifications.notifyUser(
          user.stellarAddress,
          NotificationType.KYC_EXPIRING,
          'KYC verification expiring soon',
          `Your KYC verification expires in ${daysLeft} day(s). Please re-verify to keep creating high-value shipments.`,
          { kycExpiresAt: user.kycExpiresAt!.toISOString(), daysLeft, threshold: days },
        );
        await this.prisma.user.update({ where: { id: user.id }, data: { [field]: now } });
        sent++;
      }
    }
    return sent;
  }

  async expireLapsed(now: Date = new Date()): Promise<number> {
    const users = await this.prisma.user.findMany({
      where: { kycStatus: KycStatus.VERIFIED, kycExpiresAt: { lte: now } },
      select: { id: true, stellarAddress: true, kycExpiresAt: true },
    });

    for (const user of users) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { kycStatus: KycStatus.UNVERIFIED },
      });
      await this.auditLog.record({
        actorAddress: user.stellarAddress,
        action: 'KYC_VERIFICATION_EXPIRED',
        resourceType: 'User',
        resourceId: user.id,
        metadata: { kycExpiresAt: user.kycExpiresAt?.toISOString() },
      });
      await this.notifications.notifyUser(
        user.stellarAddress,
        NotificationType.KYC_EXPIRED,
        'KYC verification expired',
        'Your KYC verification has expired. Please verify again to create high-value shipments.',
        { kycExpiresAt: user.kycExpiresAt?.toISOString() },
      );
    }
    return users.length;
  }
}
