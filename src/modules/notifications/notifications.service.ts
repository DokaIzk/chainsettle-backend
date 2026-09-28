import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';
import * as Handlebars from 'handlebars';
import { WebPushService } from './web-push.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import { NotificationsGateway } from './notifications.gateway';
import { WebhooksService } from '../webhooks/webhooks.service';
import { PushNotificationService } from './push-notification.service';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { DEFAULT_LOCALE, I18nService } from '../../i18n/i18n.service';

type ChannelPrefs = { inApp: boolean; email: boolean; slack?: boolean; push?: boolean };
type PreferenceMap = Record<NotificationType, ChannelPrefs>;
export type DigestFrequency = 'instant' | 'daily' | 'weekly';
type StoredPreferences = PreferenceMap & {
  _meta?: { digestFrequency?: DigestFrequency };
  _quietHours?: { enabled: boolean; start: string; end: string; timezone: string };
};

const DEFAULT_DIGEST_FREQUENCY: DigestFrequency = 'daily';

function buildDefaultPreferences(): PreferenceMap {
  return Object.values(NotificationType).reduce((acc, type) => {
    acc[type] = { inApp: true, email: true, slack: true, push: true };
    return acc;
  }, {} as PreferenceMap);
}

function normalizeChannelPrefs(raw: Partial<ChannelPrefs> | undefined): ChannelPrefs {
  return {
    inApp: raw?.inApp ?? true,
    email: raw?.email ?? true,
    slack: raw?.slack ?? true,
    push: raw?.push ?? true,
  };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: nodemailer.Transporter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly i18n: I18nService,
    @Optional() private readonly gateway: NotificationsGateway,
    @Optional() private readonly webhooks: WebhooksService,
    @Optional() private readonly webPush: WebPushService,
  ) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get('SMTP_HOST'),
      port: this.config.get<number>('SMTP_PORT', 587),
      secure: false,
      auth: {
        user: this.config.get('SMTP_USER'),
        pass: this.config.get('SMTP_PASS'),
      },
    });
  }

  /**
   * Creates an in-app notification for a user (by their Stellar address)
   * and optionally sends an email if they have one registered.
   * Both channels are gated on the user's NotificationPreference record.
   * When a Slack webhook URL is configured and the type opts into Slack,
   * a formatted message is also posted to that channel.
   */
  async notifyUser(
    stellarAddress: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, any>,
  ) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { stellarAddress },
      });

      if (!user) {
        this.logger.warn(`No user found for address ${stellarAddress} — skipping notification`);
        return;
      }

      const { preferences: prefs, slackWebhookUrl } = await this.getOrCreatePreferenceRecord(user.id);
      const quietHours = (prefs as StoredPreferences)._quietHours;
      const deliverAfter = type === NotificationType.SYSTEM_ALERT && data?.urgent === true ? null : this.getQuietHoursEnd(new Date(), quietHours);
      const { inApp, email: emailEnabled, slack: slackEnabled, push: pushEnabled } = normalizeChannelPrefs(prefs[type]);

      if (!inApp) return;

      const notification = await this.prisma.notification.create({
        data: { userId: user.id, type, title, message, data: data ?? {}, ...(deliverAfter ? { deliverAfter } : {}) },
      });

      if (!deliverAfter && emailEnabled && user.email) {
        await this.sendEmail(user.email, title, message, undefined, type, data);
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: { emailSent: true },
        });
      }

      if (!deliverAfter && slackEnabled && slackWebhookUrl) {
        await this.sendSlackMessage(slackWebhookUrl, type, title, message, data);
      }

      this.gateway?.pushToUser(user.id, notification);

      if (!deliverAfter && pushEnabled) {
        this.webPush
          ?.sendToUser(user.id, type, title, message, data as Record<string, string> | undefined)
          .catch((err) => this.logger.error('Web push dispatch error', err.message));
      }

      this.webhooks
        ?.dispatch(type, { notificationId: notification.id, ...(data ?? {}) })
        .catch((err) => this.logger.error('Webhook dispatch error', err.message));

      return notification;
    } catch (error) {
      this.logger.error(`Failed to notify ${stellarAddress}`, error.message);
    }
  }
   * preference. Used for high-signal events such as direct @mentions (#190).
   */
  async notifyUserWithForcedEmail(
    stellarAddress: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, any>,
  ) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { stellarAddress },
      });

      if (!user) {
        this.logger.warn(`No user found for address ${stellarAddress} — skipping mention notification`);
        return;
      }

      const prefs = await this.getOrCreatePreferences(user.id);
      const deliverAfter = type === NotificationType.SYSTEM_ALERT && data?.urgent === true ? null : this.getQuietHoursEnd(new Date(), (prefs as StoredPreferences)._quietHours);
      const { inApp } = prefs[type] ?? prefs[NotificationType.COMMENT_ADDED];

      if (!inApp) return;

      const notification = await this.prisma.notification.create({
        data: { userId: user.id, type, title, message, data: { ...(data ?? {}), ...(deliverAfter ? { forceEmail: true } : {}) }, ...(deliverAfter ? { deliverAfter } : {}) },
      });

      // Force email delivery regardless of digest preference when the user has an email
      if (user.email && !deliverAfter) {
        await this.sendEmail(user.email, title, message, undefined, type, data);
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: { emailSent: true },
        });
      }

      this.gateway?.pushToUser(user.id, notification);

      this.webhooks
        ?.dispatch(type, { notificationId: notification.id, ...(data ?? {}) })
        .catch((err) => this.logger.error('Webhook dispatch error', err.message));

      return notification;
    } catch (error) {
      this.logger.error(`Failed to send mention notification to ${stellarAddress}`, error.message);
    }
  }

  /**
   * Fans out an in-app notification to all users watching a shipment.
   * Watchers do NOT receive email notifications for these events.
   */
  async notifyWatchers(
    shipmentId: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, any>,
  ) {
    try {
      const watchers = await this.prisma.shipmentWatcher.findMany({
        where: { shipmentId },
        include: { user: true },
      });

      if (!watchers || watchers.length === 0) return;

      const notificationsData = watchers.map((w) => ({
        userId: w.userId,
        type,
        title,
        message,
        data: data ?? {},
      }));

      await this.prisma.notification.createMany({
        data: notificationsData,
      });

      // Optionally, push to the gateway for live updates
      const newlyCreated = await this.prisma.notification.findMany({
        where: {
          type,
          title,
          userId: { in: watchers.map((w) => w.userId) },
        },
        orderBy: { createdAt: 'desc' },
        take: watchers.length,
      });

      for (const notif of newlyCreated) {
        this.gateway?.pushToUser(notif.userId, notif);
      }
    } catch (error) {
      this.logger.error(`Failed to notify watchers for shipment ${shipmentId}`, (error as Error).message);
    }
  }

  /**
   * Sends a test notification to the caller, routed through the normal
   * notification pipeline so it exercises preferences + email delivery for real.
   */
  async sendTestNotification(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      this.logger.warn(`No user found for id ${userId} — skipping test notification`);
      return;
    }

    return this.notifyUser(
      user.stellarAddress,
      NotificationType.SYSTEM_ALERT,
      'Test Notification',
      'This is a test notification to verify your notification pipeline is working correctly.',
    );
  }

  async getOrCreatePreferences(userId: string): Promise<PreferenceMap> {
    const record = await this.getOrCreatePreferenceRecord(userId);
    return record.preferences;
  }

  private async getOrCreatePreferenceRecord(userId: string): Promise<{
    preferences: PreferenceMap;
    slackWebhookUrl: string | null;
  }> {
    const record = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, preferences: buildDefaultPreferences() },
      update: {},
    });
    return {
      preferences: record.preferences as PreferenceMap,
      slackWebhookUrl: record.slackWebhookUrl ?? null,
    };
  }

  private validateQuietHours(q: any): void {
    if (!q || typeof q.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(q.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(q.end) || typeof q.timezone !== 'string') throw new BadRequestException('quietHours must contain enabled, HH:mm start/end, and an IANA timezone');
    try { new Intl.DateTimeFormat('en-US', { timeZone: q.timezone }); } catch { throw new BadRequestException('quietHours.timezone must be a valid IANA timezone'); }
  }

  async isQuietHours(userId: string): Promise<boolean> {
    const prefs = await this.getOrCreatePreferences(userId) as StoredPreferences;
    return this.getQuietHoursEnd(new Date(), prefs._quietHours) !== null;
  }
  async updatePreferences(userId: string, dto: UpdatePreferencesDto) {
    if (dto.quietHours !== undefined) this.validateQuietHours(dto.quietHours);
    const current = (await this.getOrCreatePreferences(userId)) as StoredPreferences;
    const merged: StoredPreferences = { ...current, ...(dto.preferences ?? {}) };
    if (dto.quietHours !== undefined) merged._quietHours = dto.quietHours;
    if (dto.digestFrequency) {
      merged._meta = { ...current._meta, digestFrequency: dto.digestFrequency };
    }

    const data: { preferences: StoredPreferences; slackWebhookUrl?: string | null } = {
      preferences: merged,
    };
    if (dto.slackWebhookUrl !== undefined) {
      data.slackWebhookUrl =
        dto.slackWebhookUrl === '' || dto.slackWebhookUrl === null
          ? null
          : dto.slackWebhookUrl;
    }

    await this.prisma.notificationPreference.update({
      where: { userId },
      data,
    });
    return this.getPreferencesResponse(userId);
  }

  /**
   * Resolves the caller's configured digest cadence, defaulting existing
   * users without a stored value to 'daily' (no migration required).
   */
  async getDigestFrequency(userId: string): Promise<DigestFrequency> {
    const prefs = (await this.getOrCreatePreferences(userId)) as StoredPreferences;
    return prefs._meta?.digestFrequency ?? DEFAULT_DIGEST_FREQUENCY;
  }

  async getPreferencesResponse(userId: string) {
    const { preferences, slackWebhookUrl } = await this.getOrCreatePreferenceRecord(userId);
    const stored = preferences as StoredPreferences;
    const { _meta, _quietHours, ...typePreferences } = stored;
    return {
      ...typePreferences,
      digestFrequency: _meta?.digestFrequency ?? DEFAULT_DIGEST_FREQUENCY,
      quietHours: _quietHours ?? { enabled: false, start: '22:00', end: '08:00', timezone: 'UTC' },
      slackWebhookUrl,
    };
  }

  private getQuietHoursEnd(now: Date, q?: { enabled: boolean; start: string; end: string; timezone: string }): Date | null {
    if (!q?.enabled) return null;
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: q.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const n = Number(local.find(x => x.type === 'hour')?.value) * 60 + Number(local.find(x => x.type === 'minute')?.value);
    const [sh, sm] = q.start.split(':').map(Number); const [eh, em] = q.end.split(':').map(Number);
    const start = sh * 60 + sm, end = eh * 60 + em;
    const active = start === end || (start < end ? n >= start && n < end : n >= start || n < end);
    if (!active) return null;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: q.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const plusDay = start > end && n >= start;
    const [y, mo, d] = date.split('-').map(Number);
    const wall = Date.UTC(y, mo - 1, d + (plusDay ? 1 : 0), eh, em);
    let utc = wall;
    for (let i = 0; i < 2; i++) {
      const parts: any = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: q.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(utc)).map(x => [x.type, x.value]));
      utc += wall - Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    }
    return new Date(utc);
  }

  async deliverDeferredNotifications() {
    const due = await this.prisma.notification.findMany({ where: { deliverAfter: { lte: new Date() } }, include: { user: { include: { notificationPreference: true } } }, take: 200, orderBy: { deliverAfter: 'asc' } });
    for (const n of due) {
      const pref = n.user.notificationPreference;
      const channels = normalizeChannelPrefs(((pref?.preferences ?? {}) as StoredPreferences)[n.type]);
      const forceEmail = (n.data as any)?.forceEmail === true;
      if ((channels.email || forceEmail) && n.user.email && !n.emailSent) {
        await this.sendEmail(n.user.email, n.title, n.message, undefined, n.type, n.data as any);
        await this.prisma.notification.update({ where: { id: n.id }, data: { emailSent: true } });
      }
      if (channels.slack && pref?.slackWebhookUrl) await this.sendSlackMessage(pref.slackWebhookUrl, n.type, n.title, n.message, n.data as any);
      if (channels.push) await this.webPush?.sendToUser(n.userId, n.type, n.title, n.message, n.data as any);
      await this.prisma.notification.update({ where: { id: n.id }, data: { deliverAfter: null } });
    }
  }
  async findForUser(userId: string, unreadOnly = false, page = 1, limit = 20) {
    const where: any = { userId };
    if (unreadOnly) where.read = false;

    const [notifications, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { data: notifications, meta: { total, page, limit } };
  }

  async findOne(userId: string, id: string) {
    return this.prisma.notification.findFirst({ where: { id, userId } });
  }

  async markRead(notificationId: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { read: true },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
  }

  async deleteAllRead(userId: string) {
    const result = await this.prisma.notification.deleteMany({
      where: { userId, read: true },
    });
    return { deletedCount: result.count };
  }

  async buildDigest(userId: string): Promise<{ subject: string; html: string } | null> {
    const unread = await this.prisma.notification.findMany({
      where: { userId, read: false },
      orderBy: { createdAt: 'desc' },
    });

    if (unread.length === 0) return null;

    const grouped = unread.reduce(
      (acc, n) => {
        const key = n.type as string;
        acc[key] = acc[key] ?? [];
        acc[key].push(n);
        return acc;
      },
      {} as Record<string, typeof unread>,
    );

    const sections = Object.entries(grouped)
      .map(([type, items]) => {
        const rows = items
          .map((n) => `<li>${n.title}</li>`)
          .join('');
        return `<h3 style="color:#1a1a2e;">${type.replace(/_/g, ' ')} (${items.length})</h3><ul>${rows}</ul>`;
      })
      .join('');

    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#1a1a2e;">ChainSettle — Daily Notification Digest</h2>
        <p>You have <strong>${unread.length}</strong> unread notification(s):</p>
        ${sections}
        <hr />
        <small style="color:#888;">Log in to ChainSettle to view and manage your notifications.</small>
      </div>
    `;

    return { subject: `Daily digest — ${unread.length} unread notification(s)`, html };
  }

  /**
   * Loads and renders a Handlebars template for the given notification type.
   * Returns null when no template file exists for that type (triggers plain-text fallback).
   * Localized copy is injected as `t` from the i18n email catalog.
   */
  private renderTemplate(
    type: NotificationType,
    data: Record<string, any>,
    locale: string = DEFAULT_LOCALE,
  ): string | null {
    const templatePath = path.join(__dirname, 'templates', `${type}.hbs`);
    if (!fs.existsSync(templatePath)) {
      return null;
    }
    try {
      const source = fs.readFileSync(templatePath, 'utf-8');
      const template = Handlebars.compile(source);
      const emailCopy = this.i18n.getEmailCopy(type, locale);
      const interpolated = emailCopy
        ? Object.fromEntries(
            Object.entries(emailCopy).map(([k, v]) => [
              k,
              typeof v === 'string'
                ? Handlebars.compile(v)(data ?? {})
                : v,
            ]),
          )
        : {};
      return template({ ...(data ?? {}), t: interpolated });
    } catch (error) {
      this.logger.error(`Failed to render template for ${type}`, error.message);
      return null;
    }
  }

  async sendEmail(
    to: string,
    subject: string,
    text: string,
    html?: string,
    type?: NotificationType,
    data?: Record<string, any>,
    locale: string = DEFAULT_LOCALE,
  ) {
    try {
      let renderedHtml = html;
      if (!renderedHtml && type) {
        renderedHtml = this.renderTemplate(type, data ?? {}, locale) ?? undefined;
      }
      const localizedSubject =
        type && this.i18n.getEmailCopy(type, locale)?.subject
          ? this.i18n.getEmailCopy(type, locale)!.subject
          : subject;
      const footer =
        this.i18n.t('email.GENERIC_FOOTER', locale) ||
        "You're receiving this because you're a participant on ChainSettle.";
      await this.transporter.sendMail({
        from: this.config.get('EMAIL_FROM', 'noreply@chainsetttle.com'),
        to,
        subject: `ChainSettle — ${localizedSubject}`,
        text,
        html: renderedHtml ?? `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a1a2e;">ChainSettle</h2>
            <p>${text}</p>
            <hr />
            <small style="color: #888;">${footer}</small>
          </div>
        `,
      });
      this.logger.log(`Email sent to ${to}: ${localizedSubject}`);
    } catch (error) {
      this.logger.error(`Email failed to ${to}`, error.message);
    }
  }

  /**
   * Posts a Slack Incoming Webhook payload for a notification event.
   * Failures are logged and never throw — Slack must not break in-app/email.
   */
  async sendSlackMessage(
    webhookUrl: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, any>,
  ) {
    try {
      const shipmentId = data?.shipmentId ? String(data.shipmentId) : undefined;
      const milestoneIndex =
        data?.milestoneIndex !== undefined ? String(data.milestoneIndex) : undefined;

      const fields = [
        shipmentId ? { type: 'mrkdwn', text: `*Shipment:*
\`${shipmentId}\`` } : null,
        milestoneIndex !== undefined
          ? { type: 'mrkdwn', text: `*Milestone:*
${milestoneIndex}` }
          : null,
        { type: 'mrkdwn', text: `*Type:*
${type}` },
      ].filter(Boolean);

      const payload = {
        text: `ChainSettle — ${title}`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `ChainSettle — ${title}`, emoji: true },
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: message },
          },
          ...(fields.length
            ? [{ type: 'section', fields }]
            : []),
        ],
      };

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.logger.error(
          `Slack webhook failed (${response.status}): ${body || response.statusText}`,
        );
        return;
      }

      this.logger.log(`Slack notification sent for ${type}: ${title}`);
    } catch (error) {
      this.logger.error(`Slack notification failed for ${type}`, (error as Error).message);
    }
  }
}
