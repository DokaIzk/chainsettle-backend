import { Injectable, CanActivate, ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfigService } from '../../config/app-config.service';

export interface MaintenanceState {
  enabled: boolean;
  message?: string;
  until?: string | null;
}

@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly appConfig: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    // GET requests (read-only) keep working during maintenance
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return true;
    }

    const path: string = req.path || req.url || '';

    // Exempt routes
    // 1. Admin routes (/admin/* or /api/v1/admin/*)
    // 2. Health routes (/health/* or /api/v1/health/*)
    // 3. Auth login/refresh (/auth/login, /auth/refresh, ...)
    // 4. KYC provider webhook (/kyc/webhook, ...)
    if (
      path.includes('/admin') ||
      path.includes('/health') ||
      path.includes('/auth/login') ||
      path.includes('/auth/refresh') ||
      path.includes('/kyc/webhook')
    ) {
      return true;
    }

    // Check maintenance mode in AppConfig
    const maintenance = await this.appConfig.getValue<MaintenanceState>('maintenance');
    if (maintenance && maintenance.enabled) {
      const message = maintenance.message || 'System is under maintenance. Writes are disabled.';
      
      // Calculate Retry-After in seconds if until date is provided
      let retryAfterSeconds = 300; // default 5 minutes
      if (maintenance.until) {
        const untilMs = new Date(maintenance.until).getTime();
        const nowMs = Date.now();
        if (untilMs > nowMs) {
          retryAfterSeconds = Math.ceil((untilMs - nowMs) / 1000);
        }
      }

      res.setHeader('Retry-After', String(retryAfterSeconds));
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message,
        until: maintenance.until ?? null,
      });
    }

    return true;
  }
}
