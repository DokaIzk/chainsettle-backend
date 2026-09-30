import { Module } from '@nestjs/common';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { TokenRegistryModule } from '../../common/token-registry/token-registry.module';
import { FxModule } from '../../common/fx/fx.module';

@Module({
  imports: [TokenRegistryModule, FxModule],
  controllers: [AdminDashboardController],
  providers: [AdminDashboardService],
})
export class AdminDashboardModule {}
