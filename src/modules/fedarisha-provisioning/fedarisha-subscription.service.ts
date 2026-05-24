import { Injectable, Logger } from '@nestjs/common';

import { FedarishaProvisioningRepository } from './fedarisha-provisioning.repository';
import { FedarishaProvisioningService } from './fedarisha-provisioning.service';

interface IRawStorage {
    type?: string;
    bucket?: string;
    endpoint?: string;
    region?: string;
    prefix?: string;
    sessionsDir?: string;
    accessKey?: string;
    secretKey?: string;
}

interface IRawTuning {
    pollIntervalMs?: number;
    writeIntervalMs?: number;
    idleTimeoutSec?: number;
    maxFileSizeBytes?: number;
}

export interface IBuildFedarishaOutboundParams {
    userId: bigint;
    userUuid: string;
    inboundTag: string;
    configProfileInboundUuid: string;
    configProfileUuid: string;
    rawInbound: unknown;
}

export interface IFedarishaOutboundData {
    storage: Required<Pick<IRawStorage, 'type' | 'bucket' | 'endpoint' | 'region' | 'prefix' | 'accessKey' | 'secretKey'>> & {
        sessionsDir: string | null;
    };
    tuning: IRawTuning | null;
}

@Injectable()
export class FedarishaSubscriptionService {
    private readonly logger = new Logger(FedarishaSubscriptionService.name);

    constructor(
        private readonly repository: FedarishaProvisioningRepository,
        private readonly provisioning: FedarishaProvisioningService,
    ) {}

    // Resolves per-user fedarisha credentials for a single host's inbound and
    // returns the storage/tuning blocks for the xray outbound. Used by the
    // host pipeline so fedarisha hosts flow through ResolveProxyConfigService
    // like any other protocol. Returns null when storage block is malformed
    // or provisioning fails — caller drops the host from the rendered config.
    public async buildOutboundForHost(
        params: IBuildFedarishaOutboundParams,
    ): Promise<IFedarishaOutboundData | null> {
        const {
            userId,
            userUuid,
            inboundTag,
            configProfileInboundUuid,
            configProfileUuid,
            rawInbound,
        } = params;

        const baseStorage = this.extractStorage(rawInbound);
        const tuning = this.extractTuning(rawInbound);
        if (!baseStorage) {
            this.logger.warn(
                `fedarisha inbound ${inboundTag} has no storage block in rawInbound — skipping`,
            );
            return null;
        }

        const node = await this.repository.findFirstNodeByInbound(
            configProfileInboundUuid,
            configProfileUuid,
        );
        if (!node) {
            this.logger.warn(
                `fedarisha inbound ${inboundTag}: no enabled node serves it (profile ${configProfileUuid})`,
            );
            return null;
        }

        const creds = await this.provisioning.ensureCredentials({
            userId,
            userUuid,
            inbound: {
                inboundTag,
                basePrefix: baseStorage.prefix ?? '',
                configProfileUuid,
                nodeAddress: node.address,
                nodePort: node.port,
            },
        });
        if (!creds) {
            this.logger.warn(
                `Skipping fedarisha inbound ${inboundTag} for user ${userUuid}: provisioning failed`,
            );
            return null;
        }

        if (!baseStorage.bucket || !baseStorage.endpoint) {
            this.logger.warn(
                `fedarisha inbound ${inboundTag}: storage block missing bucket or endpoint — skipping`,
            );
            return null;
        }

        return {
            storage: {
                // Inbound's storage.type names the node-side PAK provider
                // (vkcloud-pak / selectel-iam / static); the xray client on
                // the user's device only knows the transport-level "s3"
                // store, so we always emit "s3" on the outbound regardless
                // of which provider issued the credentials.
                type: 's3',
                bucket: baseStorage.bucket,
                endpoint: baseStorage.endpoint,
                region: baseStorage.region ?? '',
                prefix: creds.prefix,
                sessionsDir: baseStorage.sessionsDir ?? null,
                accessKey: creds.accessKey,
                secretKey: creds.secretKey,
            },
            tuning: tuning,
        };
    }

    private extractStorage(raw: unknown): IRawStorage | null {
        const settings = this.pickObject(raw, 'settings');
        const storage = this.pickObject(settings, 'storage');
        if (!storage) return null;
        return storage as IRawStorage;
    }

    private extractTuning(raw: unknown): IRawTuning | null {
        const settings = this.pickObject(raw, 'settings');
        const tuning = this.pickObject(settings, 'tuning');
        return tuning ? (tuning as IRawTuning) : null;
    }

    private pickObject(raw: unknown, key: string): Record<string, unknown> | null {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const value = (raw as Record<string, unknown>)[key];
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        return value as Record<string, unknown>;
    }
}
