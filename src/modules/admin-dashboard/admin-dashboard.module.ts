import { Module } from '@nestjs/common';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { WeeklyAdminSummaryJob } from './weekly-admin-summary.job';
import { TokenRegistryModule } from '../../common/token-registry/token-registry.module';
import { FxModule } from '../../common/fx/fx.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [TokenRegistryModule, FxModule, NotificationsModule],
  controllers: [AdminDashboardController],
  providers: [AdminDashboardService, WeeklyAdminSummaryJob],
  exports: [AdminDashboardService, WeeklyAdminSummaryJob],
})
export class AdminDashboardModule {}
