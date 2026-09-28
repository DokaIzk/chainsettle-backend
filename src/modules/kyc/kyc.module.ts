import { Global, Module } from '@nestjs/common';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminKycController } from './admin-kyc.controller';
import { KycReviewService } from './kyc-review.service';

@Global()
@Module({
  imports: [AuditLogsModule, NotificationsModule],
  controllers: [KycController, AdminKycController],
  providers: [KycService, KycReviewService],
  exports: [KycService],
})
export class KycModule {}
