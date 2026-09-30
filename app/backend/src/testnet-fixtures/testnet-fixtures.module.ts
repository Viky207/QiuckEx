import { Module } from '@nestjs/common';

import { MetricsModule } from '../metrics/metrics.module';
import { TestnetFixtureManager } from './testnet-fixture.manager';

/**
 * Testnet fixture manager (issue #283).
 *
 * Imported by the application module so a runbook step or an operator script
 * can resolve fixtures without bespoke wiring. The manager itself refuses to
 * act on mainnet, so the module being present on a mainnet deployment is inert
 * rather than dangerous.
 */
@Module({
  imports: [MetricsModule],
  providers: [TestnetFixtureManager],
  exports: [TestnetFixtureManager],
})
export class TestnetFixturesModule {}
