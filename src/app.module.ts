import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { SirvModule } from 'nest-sirv';
import { ClsModule } from 'nestjs-cls';

import { Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { CommonConfigModule } from '@common/config/common-config/common-config.module';
import { PrismaModule } from '@common/database';
import { PrismaService } from '@common/database/prisma.service';
import { RawCacheModule } from '@common/raw-cache/raw-cache.module';
import { RuntimeMetricsModule } from '@common/runtime-metrics/runtime-metrics.module';
import { getAssetsPath } from '@common/utils/get-assets-path';
import { disableFrontend } from '@common/utils/startup-app/is-development';

import { IntegrationModules } from '@integration-modules/integration-modules';

import { RemnawaveModules } from '@modules/remnawave-backend.modules';

import { QueueModule } from '@queue/queue.module';

const HASHED = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i;

@Module({
    imports: [
        RawCacheModule,
        CommonConfigModule,
        PrismaModule,
        ClsModule.forRoot({
            plugins: [
                new ClsPluginTransactional({
                    imports: [PrismaModule],
                    adapter: new TransactionalAdapterPrisma({
                        prismaInjectionToken: PrismaService,
                    }),
                }),
            ],
        }),
        EventEmitterModule.forRoot({
            wildcard: true,
            delimiter: '.',
        }),

        IntegrationModules,
        RemnawaveModules,
        ConditionalModule.registerWhen(
            SirvModule.forRoot({
                rootPath: getAssetsPath(),
                exclude: ['/api'],
                sirv: {
                    // Serve the .br/.gz siblings the image builds, and answer
                    // revalidation with 304. Without an ETag sirv has no 304 path
                    // at all -- it never reads If-Modified-Since -- so the
                    // `no-cache` below turns into a full re-download of every
                    // unhashed asset on every page load. main.wasm is 56.8 MB.
                    brotli: true,
                    gzip: true,
                    etag: true,
                    setHeaders(res, pathname) {
                        if (HASHED.test(pathname)) {
                            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                        } else {
                            res.setHeader('Cache-Control', 'no-cache');
                        }
                    },
                },
            }),
            () => !disableFrontend(),
        ),

        QueueModule,
        RuntimeMetricsModule,
    ],
})
export class AppModule implements OnApplicationShutdown {
    private readonly logger = new Logger(AppModule.name);

    async onApplicationShutdown(signal?: string): Promise<void> {
        if (signal) {
            this.logger.log(`${signal} signal received, shutting down...`);
        }
    }
}
