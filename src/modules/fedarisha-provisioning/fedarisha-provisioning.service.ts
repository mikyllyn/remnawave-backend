import { Injectable, Logger } from '@nestjs/common';

import { AxiosService } from '@common/axios/axios.service';

import { FedarishaProvisioningRepository } from './fedarisha-provisioning.repository';
import {
    IEnsureCredentialsInput,
    IEnsureCredentialsResult,
    IFedarishaInboundContext,
    IFedarishaPakPayload,
} from './fedarisha-provisioning.types';

@Injectable()
export class FedarishaProvisioningService {
    private readonly logger = new Logger(FedarishaProvisioningService.name);

    constructor(
        private readonly repository: FedarishaProvisioningRepository,
        private readonly axiosService: AxiosService,
    ) {}

    public async ensureCredentials(
        input: IEnsureCredentialsInput & { userId: bigint },
    ): Promise<IEnsureCredentialsResult | null> {
        const expectedPrefix = this.resolveUserPrefix(
            input.inbound.basePrefix,
            input.userId.toString(),
        );

        const existing = await this.repository.getPak(input.userId, input.inbound.inboundTag);
        // Fast path: if a stored PAK matches the expected prefix and the node
        // confirms it still authenticates against the bucket the inbound now
        // serves, reuse it. The probe is what catches admin-side bucket/
        // endpoint swaps and out-of-band PAK deletions — without it we'd hand
        // the user dead credentials.
        if (
            existing &&
            existing.prefix === expectedPrefix &&
            (await this.probeStoredPak(input.inbound, input.userUuid, existing))
        ) {
            return {
                accessKey: existing.accessKey,
                secretKey: existing.secretKey,
                prefix: existing.prefix,
            };
        }

        if (existing && existing.prefix !== expectedPrefix) {
            // Revoke the old PAK before issuing a replacement. VK Cloud keys
            // PAKs by username, so a prefix migration would otherwise hit
            // UserAlreadyExists before the new prefix can be created.
            await this.callNodeRevoke(input.inbound, input.userUuid, existing.prefix);
        }

        const provisioned = await this.callNodeProvision(input, expectedPrefix);
        if (!provisioned) return null;

        const payload: IFedarishaPakPayload = {
            accessKey: provisioned.accessKey,
            secretKey: provisioned.secretKey,
            prefix: expectedPrefix,
            configProfileUuid: input.inbound.configProfileUuid,
            issuedAt: new Date().toISOString(),
        };

        await this.repository.upsertPak(input.userId, input.inbound.inboundTag, payload);

        return {
            accessKey: payload.accessKey,
            secretKey: payload.secretKey,
            prefix: payload.prefix,
        };
    }

    private async probeStoredPak(
        inbound: IFedarishaInboundContext,
        userUuid: string,
        pak: IFedarishaPakPayload,
    ): Promise<boolean> {
        const result = await this.axiosService.probeFedarishaUser(
            {
                userUuid,
                inboundTag: inbound.inboundTag,
                prefix: pak.prefix,
                accessKey: pak.accessKey,
                secretKey: pak.secretKey,
            },
            inbound.nodeAddress,
            inbound.nodePort,
        );

        if (!result.isOk) {
            // Transport-level failure (node unreachable, JWT expired, etc.).
            // Don't punish the user for an infra wobble — keep the cached PAK
            // and let the next render retry. If the node is genuinely down,
            // re-issuing wouldn't work either.
            this.logger.warn(
                `probeFedarishaUser transport failed for user ${userUuid}, inbound ${inbound.inboundTag}: ${result.message} — keeping cached PAK`,
            );
            return true;
        }

        const payload = result.response.response;
        if (!payload.isOk) {
            // Node-side error (e.g. couldn't resolve inbound from xray config).
            // Same reasoning as above — don't force a re-issue on a config
            // hiccup unrelated to the credentials themselves.
            this.logger.warn(
                `Node probe errored for user ${userUuid}, inbound ${inbound.inboundTag}: ${payload.error ?? 'unknown'} — keeping cached PAK`,
            );
            return true;
        }

        return payload.exists;
    }

    // Re-issue PAKs for every fedarisha inbound the user is entitled to,
    // skipping inbounds that already have a stored PAK. Used by the status-
    // restore path (ENABLED/TRAFFIC_RESET/MODIFIED) so the bucket creds are
    // ready before the client refetches its subscription — without this the
    // user appears stuck after admin "adds traffic" until their app's next
    // periodic update fires.
    public async ensureForUser(userId: bigint, userUuid: string): Promise<void> {
        const inbounds = await this.repository.findUserFedarishaInbounds(userId);
        if (inbounds.length === 0) return;

        const existingTags = new Set(
            (await this.repository.listPaks(userId)).map((p) => p.inboundTag),
        );

        for (const inbound of inbounds) {
            if (existingTags.has(inbound.tag)) continue;

            const node = await this.repository.findFirstNodeByInbound(
                inbound.uuid,
                inbound.profileUuid,
            );
            if (!node) {
                this.logger.warn(
                    `ensureForUser: no enabled node serves inbound ${inbound.tag} (user ${userUuid}, profile ${inbound.profileUuid})`,
                );
                continue;
            }

            const basePrefix = this.extractBasePrefix(inbound.rawInbound);

            await this.ensureCredentials({
                userId,
                userUuid,
                inbound: {
                    inboundTag: inbound.tag,
                    basePrefix,
                    configProfileUuid: inbound.profileUuid,
                    nodeAddress: node.address,
                    nodePort: node.port,
                },
            });
        }
    }

    private extractBasePrefix(rawInbound: unknown): string {
        if (!rawInbound || typeof rawInbound !== 'object' || Array.isArray(rawInbound)) return '';
        const settings = (rawInbound as Record<string, unknown>).settings;
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return '';
        const storage = (settings as Record<string, unknown>).storage;
        if (!storage || typeof storage !== 'object' || Array.isArray(storage)) return '';
        const prefix = (storage as Record<string, unknown>).prefix;
        return typeof prefix === 'string' ? prefix : '';
    }

    public async revokeForUser(userId: bigint, userUuid: string): Promise<void> {
        const stored = await this.repository.listPaks(userId);
        if (stored.length === 0) return;

        for (const { inboundTag, pak } of stored) {
            const node = await this.repository.findFirstNodeByProfile(pak.configProfileUuid);
            if (!node) {
                // Profile is no longer bound to any enabled node — bucket entry
                // stays orphaned until the operator cleans up. Don't block the
                // user-delete path on it; just drop the local PAK row.
                this.logger.warn(
                    `revokeForUser: no enabled node for profile ${pak.configProfileUuid} (user ${userUuid}, inbound ${inboundTag})`,
                );
                continue;
            }

            await this.callNodeRevoke(
                {
                    inboundTag,
                    basePrefix: '',
                    configProfileUuid: pak.configProfileUuid,
                    nodeAddress: node.address,
                    nodePort: node.port,
                },
                userUuid,
                pak.prefix,
            );
        }

        await this.repository.clearAllPaks(userId);
    }

    public resolveUserPrefix(basePrefix: string, userKey: string): string {
        const trimmed = (basePrefix ?? '').replace(/\/+$/, '');
        const head = trimmed.length === 0 ? '' : `${trimmed}/`;
        return `${head}${userKey}/`;
    }

    private async callNodeProvision(
        input: IEnsureCredentialsInput,
        prefix: string,
    ): Promise<{ accessKey: string; secretKey: string } | null> {
        const { inbound, userUuid } = input;
        const result = await this.axiosService.provisionFedarishaUser(
            { userUuid, inboundTag: inbound.inboundTag, prefix },
            inbound.nodeAddress,
            inbound.nodePort,
        );

        if (!result.isOk) {
            this.logger.warn(
                `provisionFedarishaUser transport failed for user ${userUuid}, inbound ${inbound.inboundTag}: ${result.message}`,
            );
            return null;
        }

        const payload = result.response.response;
        if (!payload.isOk || !payload.accessKey || !payload.secretKey) {
            this.logger.warn(
                `Node refused PAK for user ${userUuid}, inbound ${inbound.inboundTag}: ${payload.error ?? 'unknown'}`,
            );
            return null;
        }

        return { accessKey: payload.accessKey, secretKey: payload.secretKey };
    }

    private async callNodeRevoke(
        inbound: IFedarishaInboundContext,
        userUuid: string,
        prefix: string,
    ): Promise<void> {
        const result = await this.axiosService.revokeFedarishaUser(
            { userUuid, inboundTag: inbound.inboundTag, prefix },
            inbound.nodeAddress,
            inbound.nodePort,
        );

        if (!result.isOk) {
            this.logger.warn(
                `revokeFedarishaUser transport failed for user ${userUuid}, inbound ${inbound.inboundTag}: ${result.message}`,
            );
            return;
        }

        const payload = result.response.response;
        if (!payload.isOk) {
            this.logger.warn(
                `Node failed to revoke PAK for user ${userUuid}, inbound ${inbound.inboundTag}: ${payload.error ?? 'unknown'}`,
            );
        }
    }
}
