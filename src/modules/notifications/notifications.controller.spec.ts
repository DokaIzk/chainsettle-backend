import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let notificationsService: jest.Mocked<NotificationsService>;

  beforeEach(async () => {
    const mockNotificationsService = {
      buildDigest: jest.fn(),
      findForUser: jest.fn(),
      markRead: jest.fn(),
      markAllRead: jest.fn(),
      deleteAllRead: jest.fn(),
      getPreferencesResponse: jest.fn(),
      updatePreferences: jest.fn(),
      sendTestNotification: jest.fn(),
      findOne: jest.fn(),
      snooze: jest.fn(),
      unsnooze: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        { provide: NotificationsService, useValue: mockNotificationsService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<NotificationsController>(NotificationsController);
    notificationsService = module.get(NotificationsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getDigestPreview', () => {
    const userId = 'user-123';

    it('should return digest if notifications exist', async () => {
      const mockDigest = { subject: 'Test Digest', html: '<p>Test</p>' };
      notificationsService.buildDigest.mockResolvedValue(mockDigest);

      const result = await controller.getDigestPreview(userId);
      expect(notificationsService.buildDigest).toHaveBeenCalledWith(userId);
      expect(result).toEqual(mockDigest);
    });

    it('should return empty subject and html if no digest exists', async () => {
      notificationsService.buildDigest.mockResolvedValue(null);

      const result = await controller.getDigestPreview(userId);
      expect(notificationsService.buildDigest).toHaveBeenCalledWith(userId);
      expect(result).toEqual({ subject: '', html: '' });
    });
  });

  describe('snooze', () => {
    const userId = 'user-123';
    const notifId = 'notif-abc';
    const until = '2099-01-01T09:00:00.000Z';

    it('calls service.snooze with the correct args and returns nothing (204)', async () => {
      notificationsService.snooze.mockResolvedValue(undefined);

      const result = await controller.snooze(notifId, userId, { until });

      expect(notificationsService.snooze).toHaveBeenCalledWith(userId, notifId, until);
      expect(result).toBeUndefined();
    });

    it('propagates NotFoundException from the service', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      notificationsService.snooze.mockRejectedValue(new NotFoundException('Notification not found'));

      await expect(controller.snooze(notifId, userId, { until })).rejects.toThrow('Notification not found');
    });

    it('propagates BadRequestException when the service rejects a past date', async () => {
      const { BadRequestException } = await import('@nestjs/common');
      notificationsService.snooze.mockRejectedValue(new BadRequestException('Snooze time must be in the future'));

      await expect(controller.snooze(notifId, userId, { until: '2000-01-01T00:00:00.000Z' })).rejects.toThrow(
        'Snooze time must be in the future',
      );
    });
  });

  describe('unsnooze', () => {
    const userId = 'user-123';
    const notifId = 'notif-abc';

    it('calls service.unsnooze with the correct args and returns nothing (204)', async () => {
      notificationsService.unsnooze.mockResolvedValue(undefined);

      const result = await controller.unsnooze(notifId, userId);

      expect(notificationsService.unsnooze).toHaveBeenCalledWith(userId, notifId);
      expect(result).toBeUndefined();
    });

    it('propagates NotFoundException from the service', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      notificationsService.unsnooze.mockRejectedValue(new NotFoundException('Notification not found'));

      await expect(controller.unsnooze(notifId, userId)).rejects.toThrow('Notification not found');
    });
  });
});
