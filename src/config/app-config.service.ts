import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { AuditLogService } from '../../modules/audit-logs/audit-log.service';
import * as Joi from 'joi';

export interface RegisteredConfigKey {
  key: string;
  description: string;
  defaultValue: any;
  schema: Joi.Schema;
}

const REDIS_CACHE_PREFIX = 'app_config:';

@Injectable()
export class AppConfigService implements OnModuleInit {
  private readonly logger = new Logger(AppConfigService.name);
  private readonly registry = new Map<string, RegisteredConfigKey>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly auditLog: AuditLogService,
  ) {
    this.registerBuiltInConfigs();
  }

  onModuleInit() {
    this.logger.log(`AppConfigRegistry initialized with ${this.registry.size} keys`);
  }

  private registerBuiltInConfigs() {
    this.registerKey({
      key: 'ipfs_upload_limits',
      description: 'IPFS max upload size and allowed MIME types',
      defaultValue: {
        maxSizeBytes: 52428800,
        allowedMimeTypes: [
          'application/pdf',
          'image/jpeg',
          'image/png',
          'image/webp',
          'image/gif',
          'video/mp4',
          'video/quicktime',
        ],
      },
      schema: Joi.object({
        maxSizeBytes: Joi.number().integer().positive().required(),
        allowedMimeTypes: Joi.array().items(Joi.string()).min(1).required(),
      }),
    });

    this.registerKey({
      key: 'maintenance',
      description: 'System read-only maintenance mode status',
      defaultValue: {
        enabled: false,
        message: 'System is under scheduled maintenance. Writes are temporarily disabled.',
        until: null,
      },
      schema: Joi.object({
        enabled: Joi.boolean().required(),
        message: Joi.string().max(500).required(),
        until: Joi.string().isoDate().allow(null).optional(),
      }),
    });
  }

  registerKey(config: RegisteredConfigKey) {
    this.registry.set(config.key, config);
  }

  listRegisteredKeys(): Array<{ key: string; description: string; defaultValue: any }> {
    return Array.from(this.registry.values()).map(({ key, description, defaultValue }) => ({
      key,
      description,
      defaultValue,
    }));
  }

  async getAllConfig(): Promise<Array<{ key: string; description: string; defaultValue: any; value: any }>> {
    const keys = Array.from(this.registry.keys());
    const dbConfigs = await this.prisma.appConfig.findMany({
      where: { key: { in: keys } },
    });
    const dbMap = new Map(dbConfigs.map((c) => [c.key, c.value]));

    return Array.from(this.registry.values()).map((reg) => ({
      key: reg.key,
      description: reg.description,
      defaultValue: reg.defaultValue,
      value: dbMap.has(reg.key) ? dbMap.get(reg.key) : reg.defaultValue,
    }));
  }

  async getValue<T = any>(key: string): Promise<T> {
    const reg = this.registry.get(key);
    if (!reg) {
      throw new NotFoundException(`Config key '${key}' is not registered`);
    }

    // Check Redis cache first
    const cacheKey = `${REDIS_CACHE_PREFIX}${key}`;
    const cached = await this.redis.getJson<T>(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const row = await this.prisma.appConfig.findUnique({ where: { key } });
    const val = row ? (row.value as unknown as T) : (reg.defaultValue as T);

    // Cache in Redis for 10 minutes
    await this.redis.setJson(cacheKey, val, 600);
    return val;
  }

  async updateValue(
    key: string,
    newValue: any,
    actorAddress: string,
    actorId?: string,
  ): Promise<any> {
    const reg = this.registry.get(key);
    if (!reg) {
      throw new BadRequestException(`Config key '${key}' is not registered`);
    }

    // Validate using Joi schema
    const { error, value: validatedValue } = reg.schema.validate(newValue, { abortEarly: false });
    if (error) {
      throw new BadRequestException(`Invalid config value for key '${key}': ${error.message}`);
    }

    const oldValue = await this.getValue(key);

    // Upsert into DB
    const updatedRow = await this.prisma.appConfig.upsert({
      where: { key },
      create: { key, value: validatedValue },
      update: { value: validatedValue },
    });

    // Invalidate Redis cache
    const cacheKey = `${REDIS_CACHE_PREFIX}${key}`;
    await this.redis.del(cacheKey);

    // Audit log change
    await this.auditLog.record({
      actorId,
      actorAddress,
      action: 'APP_CONFIG_UPDATED',
      resourceType: 'AppConfig',
      resourceId: key,
      metadata: { key, oldValue, newValue: validatedValue },
    });

    this.logger.log(`AppConfig '${key}' updated by ${actorAddress}`);
    return updatedRow.value;
  }
}
