import { IsIn, IsObject, IsOptional, IsString, IsUrl, ValidateIf, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { DigestFrequency } from '../notifications.service';

const DIGEST_FREQUENCIES: DigestFrequency[] = ['instant', 'daily', 'weekly'];

export class UpdatePreferencesDto {
  @ApiProperty({
    description: 'Partial map of NotificationType to channel flags',
    example: { PROOF_SUBMITTED: { inApp: true, email: false, slack: true, sms: false, discord: true } },
    required: false,
  })
  @IsOptional()
  @IsObject()
  preferences?: Partial<
    Record<NotificationType, { inApp: boolean; email: boolean; slack?: boolean; sms?: boolean; discord?: boolean }>
  >;

  @ApiProperty({
    description: 'How often to receive the notification digest email',
    enum: DIGEST_FREQUENCIES,
    required: false,
  })
  @IsOptional()
  @IsIn(DIGEST_FREQUENCIES)
  digestFrequency?: DigestFrequency;

  @ApiProperty({
    description:
      'Slack Incoming Webhook URL for milestone/shipment events. Pass null or empty string to remove.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsUrl({ require_tld: false })
  @IsString()
  slackWebhookUrl?: string | null;

  @ApiProperty({
    description:
      'Discord Incoming Webhook URL for milestone/shipment events. Pass null or empty string to remove.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsUrl({ require_tld: false, protocols: ['https'] })
  @Matches(/^https:\/\/discord\.com\/api\/webhooks\//, {
    message: 'Discord webhook URL must be a valid Discord webhook URL (https://discord.com/api/webhooks/...)',
  })
  @IsString()
  discordWebhookUrl?: string | null;
}
