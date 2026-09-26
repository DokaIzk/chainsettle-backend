import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { ApiKeyStrategy } from './api-key.strategy';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeyExpiryJob } from './api-key-expiry.job';
import { UsersController } from './users.controller';
import { SessionService } from './session.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '7d') },
      }),
    }),
    NotificationsModule,
    AuditLogsModule,
  ],
  controllers: [AuthController, ApiKeysController, UsersController],
  providers: [AuthService, JwtStrategy, ApiKeyStrategy, ApiKeyExpiryJob, SessionService],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
