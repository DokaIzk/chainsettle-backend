import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FxRateService } from '../../common/fx/fx-rate.service';

export interface MetricComparison {
  current: number;
  previous: number;
  changePct: number;
}

@Injectable()
export class WeeklyAdminSummaryJob {
  private readonly logger = new Logger(WeeklyAdminSummaryJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly fxRate: FxRateService,
  ) {}

  // Cron schedule: Monday 08:00 UTC (0 8 * * 1)
  @Cron('0 8 * * 1')
  async handleWeeklySummary() {
    const lockKey = 'cron:weekly_admin_summary_lock';
    const lockToken = `lock_${Date.now()}`;
    // Lock for 1 hour (3600000 ms)
    const acquired = await this.redis.acquireLock(lockKey, lockToken, 3600000);
    if (!acquired) {
      this.logger.log('Weekly admin summary job already locked by another instance. Skipping.');
      return;
    }

    try {
      this.logger.log('Starting weekly admin summary email distribution...');
      const summaryData = await this.gatherMetrics();
      await this.sendSummaries(summaryData);
    } catch (err: any) {
      this.logger.error(`Error executing weekly admin summary job: ${err.message}`, err.stack);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  async gatherMetrics() {
    const now = new Date();
    const currentEnd = new Date(now);
    const currentStart = new Date(now);
    currentStart.setDate(currentStart.getDate() - 7);

    const previousEnd = new Date(currentStart);
    const previousStart = new Date(previousEnd);
    previousStart.setDate(previousStart.getDate() - 7);

    const [newUsersCurr, newUsersPrev] = await Promise.all([
      this.prisma.user.count({ where: { createdAt: { gte: currentStart, lt: currentEnd } } }),
      this.prisma.user.count({ where: { createdAt: { gte: previousStart, lt: previousEnd } } }),
    ]);

    const [shipmentsCurr, shipmentsPrev] = await Promise.all([
      this.prisma.shipment.count({ where: { createdAt: { gte: currentStart, lt: currentEnd } } }),
      this.prisma.shipment.count({ where: { createdAt: { gte: previousStart, lt: previousEnd } } }),
    ]);

    // Volume calculation
    const [currShipmentsList, prevShipmentsList] = await Promise.all([
      this.prisma.shipment.findMany({
        where: { createdAt: { gte: currentStart, lt: currentEnd } },
        select: { totalAmount: true, tokenSymbol: true, tokenDecimals: true },
      }),
      this.prisma.shipment.findMany({
        where: { createdAt: { gte: previousStart, lt: previousEnd } },
        select: { totalAmount: true, tokenSymbol: true, tokenDecimals: true },
      }),
    ]);

    const calculateVolumeUsd = async (shipments: Array<{ totalAmount: bigint; tokenSymbol: string; tokenDecimals: number }>) => {
      let total = 0;
      for (const s of shipments) {
        const rateEntry = await this.fxRate.getUsdRate(s.tokenSymbol);
        const rate = rateEntry?.rate ?? 1.0;
        const humanVal = Number(s.totalAmount) / (10 ** s.tokenDecimals);
        total += humanVal * rate;
      }
      return Math.round(total * 100) / 100;
    };

    const volumeCurr = await calculateVolumeUsd(currShipmentsList);
    const volumePrev = await calculateVolumeUsd(prevShipmentsList);

    // Disputes count
    const [disputesCurr, disputesPrev] = await Promise.all([
      this.prisma.milestone.count({
        where: { status: 'DISPUTED', disputedAt: { gte: currentStart, lt: currentEnd } },
      }),
      this.prisma.milestone.count({
        where: { status: 'DISPUTED', disputedAt: { gte: previousStart, lt: previousEnd } },
      }),
    ]);

    // DLQ size (Failed events)
    const [dlqCurr, dlqPrev] = await Promise.all([
      this.prisma.failedEvent.count({ where: { createdAt: { gte: currentStart, lt: currentEnd } } }),
      this.prisma.failedEvent.count({ where: { createdAt: { gte: previousStart, lt: previousEnd } } }),
    ]);

    // Webhook failure rate calculation
    const calculateWebhookFailureRate = async (start: Date, end: Date) => {
      const total = await this.prisma.webhookDelivery.count({
        where: { createdAt: { gte: start, lt: end } },
      });
      if (total === 0) return 0;
      const failed = await this.prisma.webhookDelivery.count({
        where: { createdAt: { gte: start, lt: end }, permanentlyFailedAt: { not: null } },
      });
      return Math.round((failed / total) * 10000) / 100; // e.g. 5.25%
    };

    const webhookRateCurr = await calculateWebhookFailureRate(currentStart, currentEnd);
    const webhookRatePrev = await calculateWebhookFailureRate(previousStart, previousEnd);

    const calcChange = (curr: number, prev: number): number => {
      if (prev === 0) return curr === 0 ? 0 : 100;
      return Math.round(((curr - prev) / prev) * 10000) / 100;
    };

    return {
      periodStart: currentStart.toISOString().split('T')[0],
      periodEnd: currentEnd.toISOString().split('T')[0],
      metrics: {
        newUsers: { current: newUsersCurr, previous: newUsersPrev, changePct: calcChange(newUsersCurr, newUsersPrev) },
        newShipments: { current: shipmentsCurr, previous: shipmentsPrev, changePct: calcChange(shipmentsCurr, shipmentsPrev) },
        totalVolumeUsd: { current: volumeCurr, previous: volumePrev, changePct: calcChange(volumeCurr, volumePrev) },
        disputes: { current: disputesCurr, previous: disputesPrev, changePct: calcChange(disputesCurr, disputesPrev) },
        dlqSize: { current: dlqCurr, previous: dlqPrev, changePct: calcChange(dlqCurr, dlqPrev) },
        webhookFailureRate: { current: webhookRateCurr, previous: webhookRatePrev, changePct: calcChange(webhookRateCurr, webhookRatePrev) },
      },
    };
  }

  async sendSummaries(data: any) {
    const admins = await this.prisma.user.findMany({
      where: {
        role: UserRole.ADMIN,
        emailVerified: true,
        email: { not: null },
      },
      select: { id: true, email: true },
    });

    let sentCount = 0;
    for (const admin of admins) {
      if (!admin.email) continue;
      const prefs = await this.notifications.getOrCreatePreferences(admin.id);
      
      // Opt-out check via NotificationPreference (check if ALL email notifications or admin summary opt out)
      const emailEnabled = Object.values(prefs).some((p) => p?.email);
      if (!emailEnabled) continue;

      const subject = `Weekly Admin Summary (${data.periodStart} - ${data.periodEnd})`;
      await this.notifications.sendEmail(
        admin.email,
        subject,
        `Weekly summary for ${data.periodStart} to ${data.periodEnd}`,
        undefined,
        'WEEKLY_ADMIN_SUMMARY' as any,
        data,
      );
      sentCount++;
    }

    this.logger.log(`Weekly summary email sent to ${sentCount} admins.`);
  }
}
