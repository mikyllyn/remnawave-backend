import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';

import {
    FEDARISHA_META_KEY,
    IFedarishaPakPayload,
    IFedarishaUserMetaSection,
} from './fedarisha-provisioning.types';

export interface IFedarishaNodeRow {
    address: string;
    port: number | null;
}

export interface IFedarishaUserInboundRow {
    uuid: string;
    tag: string;
    profileUuid: string;
    rawInbound: unknown;
}

@Injectable()
export class FedarishaProvisioningRepository {
    constructor(private readonly prisma: TransactionHost<TransactionalAdapterPrisma>) {}

    public async findFirstNodeByProfile(
        configProfileUuid: string,
    ): Promise<IFedarishaNodeRow | null> {
        const node = await this.prisma.tx.nodes.findFirst({
            where: {
                activeConfigProfileUuid: configProfileUuid,
                isDisabled: false,
            },
            select: { address: true, port: true },
        });
        return node ? { address: node.address, port: node.port } : null;
    }

    // Pick a node that actually serves this specific inbound. Multiple nodes
    // can share the same active profile while being assigned disjoint subsets
    // of its inbounds via config_profile_inbounds_to_nodes — provisioning
    // against a node that does not have the inbound in its xray config returns
    // "inbound not found" and the host gets silently dropped from the user's
    // subscription. Fall back to profile-level lookup if the inbound has no
    // explicit node assignment yet (fresh profile, in-progress wiring).
    public async findFirstNodeByInbound(
        configProfileInboundUuid: string,
        configProfileUuid: string,
    ): Promise<IFedarishaNodeRow | null> {
        const link = await this.prisma.tx.configProfileInboundsToNodes.findFirst({
            where: {
                configProfileInboundUuid,
                node: {
                    isDisabled: false,
                    activeConfigProfileUuid: configProfileUuid,
                },
            },
            select: { node: { select: { address: true, port: true } } },
        });
        if (link?.node) {
            return { address: link.node.address, port: link.node.port };
        }
        return this.findFirstNodeByProfile(configProfileUuid);
    }

    // Fedarisha inbounds the user is currently entitled to via internal squad
    // membership. Used to repopulate PAK rows when status flips back to ACTIVE
    // (the LIMITED/EXPIRED handlers wipe them, but the natural restore path —
    // a subscription render — only runs when the client refetches, which can
    // be hours away). Bypassing the host table on purpose: a user without any
    // host row for the inbound still receives credentials in xray-json output,
    // so squad membership is the authoritative entitlement.
    public async findUserFedarishaInbounds(
        userId: bigint,
    ): Promise<IFedarishaUserInboundRow[]> {
        const rows = await this.prisma.tx.internalSquadInbounds.findMany({
            where: {
                internalSquad: { internalSquadMembers: { some: { userId } } },
                inbound: { type: 'fedarisha' },
            },
            select: {
                inbound: {
                    select: {
                        uuid: true,
                        tag: true,
                        profileUuid: true,
                        rawInbound: true,
                    },
                },
            },
        });
        return rows.map((r) => ({
            uuid: r.inbound.uuid,
            tag: r.inbound.tag,
            profileUuid: r.inbound.profileUuid,
            rawInbound: r.inbound.rawInbound,
        }));
    }

    public async getPak(userId: bigint, inboundTag: string): Promise<IFedarishaPakPayload | null> {
        const row = await this.prisma.tx.userMeta.findUnique({ where: { userId } });
        const section = this.extractSection(row?.metadata);
        return section?.[inboundTag] ?? null;
    }

    public async upsertPak(
        userId: bigint,
        inboundTag: string,
        pak: IFedarishaPakPayload,
    ): Promise<void> {
        const row = await this.prisma.tx.userMeta.findUnique({ where: { userId } });
        const metadata = this.normaliseMetadata(row?.metadata);
        const section = { ...(this.extractSection(metadata) ?? {}) };
        section[inboundTag] = pak;
        metadata[FEDARISHA_META_KEY] = section;

        await this.prisma.tx.userMeta.upsert({
            where: { userId },
            update: { metadata },
            create: { userId, metadata },
        });
    }

    public async deletePakForInbound(userId: bigint, inboundTag: string): Promise<void> {
        const row = await this.prisma.tx.userMeta.findUnique({ where: { userId } });
        if (!row) return;

        const metadata = this.normaliseMetadata(row.metadata);
        const section = this.extractSection(metadata);
        if (!section || !(inboundTag in section)) return;

        const next = { ...section };
        delete next[inboundTag];

        if (Object.keys(next).length === 0) {
            delete metadata[FEDARISHA_META_KEY];
        } else {
            metadata[FEDARISHA_META_KEY] = next;
        }

        await this.prisma.tx.userMeta.update({
            where: { userId },
            data: { metadata },
        });
    }

    public async listPaks(
        userId: bigint,
    ): Promise<Array<{ inboundTag: string; pak: IFedarishaPakPayload }>> {
        const row = await this.prisma.tx.userMeta.findUnique({ where: { userId } });
        const section = this.extractSection(row?.metadata);
        if (!section) return [];
        return Object.entries(section).map(([inboundTag, pak]) => ({ inboundTag, pak }));
    }

    public async clearAllPaks(userId: bigint): Promise<void> {
        const row = await this.prisma.tx.userMeta.findUnique({ where: { userId } });
        if (!row) return;
        const metadata = this.normaliseMetadata(row.metadata);
        if (!(FEDARISHA_META_KEY in metadata)) return;
        delete metadata[FEDARISHA_META_KEY];

        await this.prisma.tx.userMeta.update({
            where: { userId },
            data: { metadata },
        });
    }

    private normaliseMetadata(raw: unknown): Record<string, unknown> {
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            return { ...(raw as Record<string, unknown>) };
        }
        return {};
    }

    private extractSection(raw: unknown): IFedarishaUserMetaSection | null {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const section = (raw as Record<string, unknown>)[FEDARISHA_META_KEY];
        if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
        return section as IFedarishaUserMetaSection;
    }
}
