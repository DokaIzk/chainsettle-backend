import { Global, Logger, Module } from '@nestjs/common';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { makeCounterProvider, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { ShipmentStatus } from '@prisma/client';
import { Gauge } from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from './metrics.service';
import {
  EVENTS_PROCESSED_COUNTER,
  EVENTS_FAILED_COUNTER,
  SHIPMENTS_CREATED_COUNTER,
  ACTIVE_SHIPMENTS_GAUGE,
  SHIPMENTS_BY_STATUS_GAUGE,
  BUILD_INFO_GAUGE,
} from './metrics.service';
import { resolveBuildInfo } from '../build-info';

const logger = new Logger('MetricsModule');

/**
 * Refreshes chainsettle_shipments_by_status on every /metrics scrape from a
 * single grouped query (#305). Every status gets a series, so a status with no
 * shipments reports 0 rather than disappearing. On a DB error the previous
 * values are kept so the scrape itself still succeeds.
 */
export async function collectShipmentsByStatus(this: Gauge<string>, prisma: PrismaService) {
  try {
    const rows = await prisma.shipment.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const counts = new Map(rows.map((row) => [row.status, row._count._all]));
    for (const status of Object.values(ShipmentStatus)) {
      this.set({ status }, counts.get(status) ?? 0);
    }
  } catch (err) {
    logger.warn(`Failed to refresh ${SHIPMENTS_BY_STATUS_GAUGE}: ${err.message}`);
  }
}

/**
 * Sets chainsettle_build_info{version,gitSha,buildTime,nodeVersion} = 1 on every
 * scrape (#427), the standard Prometheus "info" pattern for joining on version.
 */
export function collectBuildInfo(this: Gauge<string>) {
  const info = resolveBuildInfo();
  this.reset();
  this.set(
    { version: info.version, gitSha: info.gitSha, buildTime: info.buildTime, nodeVersion: info.nodeVersion },
    1,
  );
}

@Global()
@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: { enabled: true },
    }),
  ],
  providers: [
    makeCounterProvider({
      name: EVENTS_PROCESSED_COUNTER,
      help: 'Total number of on-chain events processed',
      labelNames: ['eventName'],
    }),
    makeCounterProvider({
      name: EVENTS_FAILED_COUNTER,
      help: 'Total number of on-chain events that failed processing',
    }),
    makeCounterProvider({
      name: SHIPMENTS_CREATED_COUNTER,
      help: 'Total number of shipments created',
    }),
    makeGaugeProvider({
      name: ACTIVE_SHIPMENTS_GAUGE,
      help: 'Current number of active shipments',
    }),
    makeGaugeProvider({
      name: SHIPMENTS_BY_STATUS_GAUGE,
      help: 'Current number of shipments in each status',
      labelNames: ['status'],
      inject: [PrismaService],
      collect: collectShipmentsByStatus,
    }),
    makeGaugeProvider({
      name: BUILD_INFO_GAUGE,
      help: 'Build information for the running instance; value is always 1',
      labelNames: ['version', 'gitSha', 'buildTime', 'nodeVersion'],
      collect: collectBuildInfo,
    }),
    MetricsService,
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
