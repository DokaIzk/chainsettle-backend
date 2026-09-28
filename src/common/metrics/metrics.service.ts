import { Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge } from 'prom-client';

export const EVENTS_PROCESSED_COUNTER = 'chainsettle_events_processed_total';
export const EVENTS_FAILED_COUNTER = 'chainsettle_events_failed_total';
export const SHIPMENTS_CREATED_COUNTER = 'chainsettle_shipments_created_total';
export const ACTIVE_SHIPMENTS_GAUGE = 'chainsettle_active_shipments';
export const SHIPMENTS_BY_STATUS_GAUGE = 'chainsettle_shipments_by_status';
export const BUILD_INFO_GAUGE = 'chainsettle_build_info';

@Injectable()
export class MetricsService {
  constructor(
    @InjectMetric(EVENTS_PROCESSED_COUNTER)
    private readonly eventsProcessed: Counter<string>,
    @InjectMetric(EVENTS_FAILED_COUNTER)
    private readonly eventsFailed: Counter<string>,
    @InjectMetric(SHIPMENTS_CREATED_COUNTER)
    private readonly shipmentsCreated: Counter<string>,
    @InjectMetric(ACTIVE_SHIPMENTS_GAUGE)
    private readonly activeShipments: Gauge<string>,
  ) {}

  incrementEventsProcessed(eventName: string): void {
    this.eventsProcessed.inc({ eventName });
  }

  incrementEventsFailed(): void {
    this.eventsFailed.inc();
  }

  incrementShipmentsCreated(): void {
    this.shipmentsCreated.inc();
  }

  incrementActiveShipments(): void {
    this.activeShipments.inc();
  }

  decrementActiveShipments(): void {
    this.activeShipments.dec();
  }

  setActiveShipments(count: number): void {
    this.activeShipments.set(count);
  }
}
