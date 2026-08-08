import { filter, shuffle } from 'lodash';
import { customAlphabet } from 'nanoid';
import {
    GRPCConfig,
    HTTPUpgradeConfig,
    HysteriaConfig,
    InboundConfig,
    KCPConfig,
    SplitHTTPConfig,
    StreamSettingsConfig,
    TCPConfig,
    WebSocketConfig,
} from 'xray-typed';

import { Injectable } from '@nestjs/common';

import { TypedConfigService } from '@common/config/app-config';
import {
    resolveEncryptionFromDecryption,
    resolveInboundAndMlDsa65PublicKey,
    resolveInboundAndPublicKey,
} from '@common/helpers/xray-config';
import { getSsPassword, isSS2022MethodFromMethod } from '@common/helpers/xray-config/ss-cipher';
import { getVlessFlow } from '@common/utils/flow';
import { TemplateEngine } from '@common/utils/templates/replace-templates-values';
import { setVlessRouteForUuid } from '@common/utils/vless-route';
import { SECURITY_LAYERS, USERS_STATUS } from '@libs/contracts/constants';

import { ExternalSquadEntity } from '@modules/external-squads/entities';
import { HostWithRawInbound } from '@modules/hosts/entities/host-with-inbound-tag.entity';
import { ISRRContext } from '@modules/subscription-response-rules/interfaces';
import { SubscriptionSettingsEntity } from '@modules/subscription-settings/entities/subscription-settings.entity';
import { UserEntity } from '@modules/users/entities';
import {
    FedarishaSubscriptionService,
    IFedarishaOutboundData,
} from '@modules/fedarisha-provisioning';

import {
    GrpcTransport,
    HttpUpgradeTransport,
    HysteriaTransport,
    KcpTransport,
    ProtocolVariant,
    ResolvedProxyConfig,
    SecurityVariant,
    TcpTransport,
    TransportVariant,
    WsTransport,
    XHttpTransport,
} from './interfaces';
import { override, toNonEmptyRecord } from './utils';

export interface IResolveProxyConfigOptions {
    subscriptionSettings: SubscriptionSettingsEntity | null;
    hosts: HostWithRawInbound[];
    user: UserEntity;
    hostsOverrides?: ExternalSquadEntity['hostOverrides'];
    fallbackOptions?: {
        showHwidMaxDeviceRemarks?: boolean;
        showHwidNotSupportedRemarks?: boolean;
        respondWithRemarks?: string[];
    };
    excludeHostsByTags?: ISRRContext['excludeHostsByTags'];
}

@Injectable()
export class ResolveProxyConfigService {
    private readonly nanoid: ReturnType<typeof customAlphabet>;
    private readonly subPublicDomain: string;
    private readonly domainRegex =
        /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

    constructor(
        private readonly configService: TypedConfigService,
        private readonly fedarishaSubscriptionService: FedarishaSubscriptionService,
    ) {
        this.nanoid = customAlphabet('0123456789abcdefghjkmnopqrstuvwxyz', 10);
        this.subPublicDomain = this.configService.getOrThrow('SUB_PUBLIC_DOMAIN');
    }

    public async resolveProxyConfig(
        options: IResolveProxyConfigOptions,
    ): Promise<ResolvedProxyConfig[]> {
        const { user, hostsOverrides, subscriptionSettings, fallbackOptions, excludeHostsByTags } =
            options;

        if (subscriptionSettings === null) {
            return [];
        }

        if (excludeHostsByTags) {
            options.hosts = options.hosts.filter(
                (h) => !h.tags.some((tag) => excludeHostsByTags.has(tag)),
            );
        }

        const earlyRemarks = this.resolveEarlyExitRemarks(
            user,
            subscriptionSettings,
            fallbackOptions,
            options.hosts.length,
        );
        if (earlyRemarks !== null) {
            return this.createFallbackHosts(
                this.templateRemarks(earlyRemarks, user, subscriptionSettings),
            );
        }

        const hosts = this.applyShuffle(options.hosts);

        const rawInbounds = hosts.map((h) => h.rawInbound);
        const [publicKeyMap, mldsa65PublicKeyMap, encryptionMap, fedarishaMap] = await Promise.all([
            resolveInboundAndPublicKey(rawInbounds),
            resolveInboundAndMlDsa65PublicKey(rawInbounds),
            resolveEncryptionFromDecryption(rawInbounds),
            this.resolveFedarishaOutbounds(hosts, user),
        ]);

        const knownRemarks = new Map<string, number>();
        const resolvedProxyConfigs: ResolvedProxyConfig[] = [];

        const userValueMap = TemplateEngine.createUserValueMap(
            user,
            subscriptionSettings,
            this.subPublicDomain,
        );

        for (const inputHost of hosts) {
            this.applyHostOverrides(inputHost, hostsOverrides);

            const finalRemark = this.deduplicateRemark(
                TemplateEngine.replace(inputHost.remark, userValueMap),
                knownRemarks,
            );

            const resolvedProxyConfig = this.buildResolvedProxyConfig({
                inputHost,
                inbound: inputHost.rawInbound as InboundConfig,
                finalRemark,
                user,
                publicKeyMap,
                mldsa65PublicKeyMap,
                encryptionMap,
                fedarishaMap,
            });

            if (resolvedProxyConfig) {
                resolvedProxyConfigs.push(resolvedProxyConfig);
            }
        }

        return resolvedProxyConfigs;
    }

    // Pre-resolves PAK creds for every fedarisha inbound the user is exposed
    // to in this batch. Done once per subscription render, deduped by
    // inboundTag — the master S3 creds are shared across nodes for the same
    // inbound, and ensureCredentials caches per (user, inbound). Hosts whose
    // inbound resolution fails (no node, missing storage, provisioning down)
    // are absent from the map → resolveProtocolOptions drops them.
    private async resolveFedarishaOutbounds(
        hosts: HostWithRawInbound[],
        user: UserEntity,
    ): Promise<Map<string, IFedarishaOutboundData>> {
        const result = new Map<string, IFedarishaOutboundData>();
        const seen = new Set<string>();

        for (const host of hosts) {
            const inbound = host.rawInbound as InboundConfig | null;
            if (!inbound || (inbound as { protocol?: string }).protocol !== 'fedarisha') continue;
            if (!host.configProfileUuid || !host.configProfileInboundUuid) continue;
            if (seen.has(host.inboundTag)) continue;
            seen.add(host.inboundTag);

            const outbound = await this.fedarishaSubscriptionService.buildOutboundForHost({
                userId: user.id,
                userUuid: user.vlessUuid,
                inboundTag: host.inboundTag,
                configProfileInboundUuid: host.configProfileInboundUuid,
                configProfileUuid: host.configProfileUuid,
                rawInbound: inbound,
            });
            if (outbound) result.set(host.inboundTag, outbound);
        }

        return result;
    }

    private resolveEarlyExitRemarks(
        user: UserEntity,
        settings: SubscriptionSettingsEntity,
        fallbackOptions: IResolveProxyConfigOptions['fallbackOptions'],
        hostCount: number,
    ): string[] | null {
        if (settings.isShowCustomRemarks) {
            if (fallbackOptions) {
                if (fallbackOptions.showHwidMaxDeviceRemarks) {
                    return settings.customRemarks.HWIDMaxDevicesExceeded;
                }
                if (fallbackOptions.showHwidNotSupportedRemarks) {
                    return settings.customRemarks.HWIDNotSupported;
                }
                if (
                    fallbackOptions.respondWithRemarks &&
                    fallbackOptions.respondWithRemarks.length > 0
                ) {
                    return fallbackOptions.respondWithRemarks;
                }
            }

            if (user.status !== USERS_STATUS.ACTIVE) {
                const statusRemarksMap: Partial<Record<string, string[]>> = {
                    [USERS_STATUS.EXPIRED]: settings.customRemarks.expiredUsers,
                    [USERS_STATUS.DISABLED]: settings.customRemarks.disabledUsers,
                    [USERS_STATUS.LIMITED]: settings.customRemarks.limitedUsers,
                };
                return statusRemarksMap[user.status] ?? [];
            }
        }

        if (hostCount === 0) {
            return settings.customRemarks.emptyHosts;
        }

        return null;
    }

    private resolveTransport(
        streamSettings: StreamSettingsConfig | undefined,
        inputHost: HostWithRawInbound,
        protocol: ProtocolVariant,
        authOptions: {
            vlessUuid: string;
        },
    ): TransportVariant {
        const rawNetwork = streamSettings?.network;

        if (rawNetwork === undefined || !streamSettings) {
            return {
                transport: 'tcp',
                transportOptions: {
                    header: null,
                },
            };
        }

        switch (rawNetwork) {
            case 'xhttp':
                return this.resolveXhttp(streamSettings.xhttpSettings, inputHost);
            case 'ws':
                return this.resolveWs(streamSettings.wsSettings, inputHost);
            case 'httpupgrade':
                return this.resolveHttpUpgrade(streamSettings.httpupgradeSettings, inputHost);
            case 'grpc':
                return this.resolveGrpc(streamSettings.grpcSettings, inputHost);
            case 'raw':
                return this.resolveTcp(streamSettings.rawSettings, inputHost);
            case 'tcp':
                return this.resolveTcp(streamSettings.tcpSettings, inputHost);
            case 'kcp':
                return this.resolveKcp(streamSettings.kcpSettings);
            case 'hysteria':
                return this.resolveHysteria(
                    streamSettings.hysteriaSettings,
                    authOptions.vlessUuid,
                    protocol,
                    inputHost.vlessRouteId,
                );
            default:
                return {
                    transport: 'tcp',
                    transportOptions: {
                        header: null,
                    },
                };
        }
    }

    private resolveXhttp(
        settings: SplitHTTPConfig | undefined,
        inputHost: HostWithRawInbound,
    ): XHttpTransport {
        return {
            transport: 'xhttp',
            transportOptions: {
                path: override(inputHost.path, settings?.path),
                host: this.resolveRandomizedValue(override(inputHost.host, settings?.host) ?? ''),
                mode: settings?.mode ?? 'auto',
                extra: override(toNonEmptyRecord(inputHost.xhttpExtraParams), settings?.extra),
            },
        };
    }

    private resolveWs(
        settings: WebSocketConfig | undefined,
        inputHost: HostWithRawInbound,
    ): WsTransport {
        return {
            transport: 'ws',
            transportOptions: {
                host: this.resolveRandomizedValue(override(inputHost.host, settings?.host) ?? ''),
                path: override(inputHost.path, settings?.path),
                headers: settings?.headers ?? null,
                heartbeatPeriod: settings?.heartbeatPeriod ?? null,
            },
        };
    }

    private resolveHttpUpgrade(
        settings: HTTPUpgradeConfig | undefined,
        inputHost: HostWithRawInbound,
    ): HttpUpgradeTransport {
        return {
            transport: 'httpupgrade',
            transportOptions: {
                path: override(inputHost.path, settings?.path),
                host: this.resolveRandomizedValue(override(inputHost.host, settings?.host) ?? ''),
                headers: settings?.headers ?? null,
            },
        };
    }

    private resolveGrpc(
        settings: GRPCConfig | undefined,
        inputHost: HostWithRawInbound,
    ): GrpcTransport {
        return {
            transport: 'grpc',
            transportOptions: {
                authority: this.resolveRandomizedValue(
                    override(inputHost.host, settings?.authority) ?? '',
                ),
                serviceName: override(inputHost.path, settings?.serviceName),
                multiMode: !!settings?.multiMode,
            },
        };
    }

    private resolveTcp(
        settings: TCPConfig | undefined,
        inputHost: HostWithRawInbound,
    ): TcpTransport {
        if (settings && settings.header && settings.header.type === 'http') {
            let baseRequest = structuredClone(settings.header.request);
            if (!baseRequest) {
                baseRequest = {
                    version: '1.1',
                    method: 'GET',
                    headers: {
                        'Accept-Encoding': ['gzip', 'deflate'],
                        Connection: ['keep-alive'],
                        Pragma: ['no-cache'],
                    },
                };
            } else {
                baseRequest.headers = baseRequest.headers || {};

                if (inputHost.host) {
                    baseRequest.headers.Host = [this.resolveRandomizedValue(inputHost.host)];
                }

                if (inputHost.path) {
                    baseRequest.path = [inputHost.path];
                }
            }

            return {
                transport: 'tcp',
                transportOptions: {
                    header: {
                        type: 'http',
                        request: baseRequest,
                    },
                },
            };
        }

        return {
            transport: 'tcp',
            transportOptions: {
                header: settings?.header ?? null,
            },
        };
    }

    private resolveKcp(settings: KCPConfig | undefined): KcpTransport {
        return {
            transport: 'kcp',
            transportOptions: {
                clientMtu: settings?.clientMtu || settings?.mtu || 1350,
                clientTti: settings?.clientTti || settings?.tti || 50,
                congestion: settings?.congestion || false,
            },
        };
    }

    private resolveHysteria(
        settings: HysteriaConfig | undefined,
        vlessUuid: string,
        protocol: ProtocolVariant,
        vlessRouteId: number | null,
    ): HysteriaTransport {
        let auth: string = '';
        if (protocol.protocol === 'hysteria') {
            auth = setVlessRouteForUuid(vlessUuid, vlessRouteId);
        } else if (settings?.auth) {
            auth = settings.auth;
        }

        return {
            transport: 'hysteria',
            transportOptions: {
                version: 2,
                auth,
            },
        };
    }

    private resolveSecurity(
        streamSettings: StreamSettingsConfig | undefined,
        inputHost: HostWithRawInbound,
        inboundTag: string,
        publicKeyMap: Map<string, string>,
        mldsa65Map: Map<string, string>,
        resolvedAddress: string,
    ): SecurityVariant {
        if (!streamSettings) {
            return {
                security: 'none',
            };
        }

        let effectiveSecurity = streamSettings.security;
        if (inputHost.securityLayer !== SECURITY_LAYERS.DEFAULT) {
            switch (inputHost.securityLayer) {
                case SECURITY_LAYERS.TLS:
                    effectiveSecurity = 'tls';
                    break;
                case SECURITY_LAYERS.NONE:
                    effectiveSecurity = 'none';
                    break;
            }
        }

        switch (effectiveSecurity) {
            case 'tls': {
                const tls = streamSettings.tlsSettings;
                const alpn =
                    override(
                        inputHost.alpn,
                        Array.isArray(tls?.alpn) ? tls.alpn.join(',') : tls?.alpn,
                    ) ?? '';

                return {
                    security: 'tls',
                    securityOptions: {
                        alpn,
                        enableSessionResumption: !!tls?.enableSessionResumption,
                        fingerprint: override(inputHost.fingerprint, tls?.fingerprint) ?? 'chrome',
                        serverName: this.resolveFinalServerName(
                            inputHost,
                            streamSettings.tlsSettings?.serverName,
                            resolvedAddress,
                        ),
                        echConfigList: tls?.echConfigList || null,
                        echForceQuery: tls?.echForceQuery || null,
                        echSockopt: toNonEmptyRecord(tls?.echSockopt),
                        pinnedPeerCertSha256: inputHost.pinnedPeerCertSha256,
                        verifyPeerCertByName: inputHost.verifyPeerCertByName,
                        cipherSuites: tls?.cipherSuites || null,
                    },
                };
            }
            case 'reality': {
                const reality = streamSettings.realitySettings;
                const shortIds = reality?.shortIds || [];
                const shortId = shortIds.length > 0 ? shortIds[0] : '';

                return {
                    security: 'reality',
                    securityOptions: {
                        fingerprint:
                            override(inputHost.fingerprint, reality?.fingerprint) ?? 'chrome',
                        publicKey: publicKeyMap.get(inboundTag) || '',
                        shortId,
                        serverName: this.resolveFinalServerName(
                            inputHost,
                            reality?.serverNames?.[0],
                            resolvedAddress,
                        ),
                        spiderX: reality?.spiderX || '',
                        mldsa65Verify: mldsa65Map.get(inboundTag) ?? null,
                    },
                };
            }
            case 'none':
                return { security: 'none' };
            default:
                return { security: 'none' };
        }
    }

    private resolveFinalServerName(
        inputHost: HostWithRawInbound,
        serverName: string | undefined,
        resolvedAddress: string,
    ): string {
        if (inputHost.keepSniBlank) {
            return '';
        }

        if (inputHost.overrideSniFromAddress) {
            return resolvedAddress;
        }

        let baseSni = serverName ?? '';

        if (inputHost.sni) {
            baseSni = inputHost.sni;
        }

        if (!baseSni && this.isDomain(inputHost.address)) {
            baseSni = inputHost.address;
        }

        return this.resolveRandomizedValue(baseSni);
    }

    private resolveProtocolOptions(
        inputHost: HostWithRawInbound,
        inbound: InboundConfig,
        user: UserEntity,
        encryption: string | undefined,
        fedarishaMap: Map<string, IFedarishaOutboundData>,
    ): ProtocolVariant | null {
        if ((inbound as { protocol?: string }).protocol === 'fedarisha') {
            const outbound = fedarishaMap.get(inputHost.inboundTag);
            if (!outbound) return null;
            return {
                protocol: 'fedarisha',
                protocolOptions: {
                    storage: outbound.storage,
                    tuning: outbound.tuning
                        ? {
                              idleTimeoutSec: outbound.tuning.idleTimeoutSec ?? null,
                              pollIntervalMs: outbound.tuning.pollIntervalMs ?? null,
                              writeIntervalMs: outbound.tuning.writeIntervalMs ?? null,
                              maxFileSizeBytes: outbound.tuning.maxFileSizeBytes ?? null,
                          }
                        : null,
                },
            };
        }

        if (!inbound.settings) {
            return null;
        }

        switch (inbound.protocol) {
            case 'vless':
                return {
                    protocol: 'vless',
                    protocolOptions: {
                        id: setVlessRouteForUuid(user.vlessUuid, inputHost.vlessRouteId),
                        encryption: encryption ?? 'none',
                        flow: getVlessFlow(inbound),
                    },
                };
            case 'trojan':
                return {
                    protocol: 'trojan',
                    protocolOptions: {
                        password: user.trojanPassword,
                    },
                };
            case 'shadowsocks':
                const settings = inbound.settings;

                let clientPassword = user.ssPassword;

                if (isSS2022MethodFromMethod(settings.method) && 'password' in settings) {
                    clientPassword = `${settings.password}:${getSsPassword(user.ssPassword, true)}`;
                }

                return {
                    protocol: 'shadowsocks',
                    protocolOptions: {
                        method: settings.method || 'chacha20-ietf-poly1305',
                        password: clientPassword,
                        uot: settings.uot || false,
                        uotVersion: settings.uotVersion || 1,
                    },
                };
            case 'hysteria':
                return {
                    protocol: 'hysteria',
                    protocolOptions: {
                        version: 2,
                    },
                };
            default:
                return null;
        }
    }

    private buildResolvedProxyConfig(ctx: {
        inputHost: HostWithRawInbound;
        inbound: InboundConfig;
        finalRemark: string;
        user: UserEntity;
        publicKeyMap: Map<string, string>;
        mldsa65PublicKeyMap: Map<string, string>;
        encryptionMap: Map<string, string>;
        fedarishaMap: Map<string, IFedarishaOutboundData>;
    }): ResolvedProxyConfig | null {
        const { inputHost, inbound, finalRemark, user } = ctx;

        const address = this.resolveRandomizedValue(inputHost.address);

        const protocol = this.resolveProtocolOptions(
            inputHost,
            inbound,
            user,
            ctx.encryptionMap.get(inputHost.inboundTag),
            ctx.fedarishaMap,
        );

        if (!protocol) {
            return null;
        }

        // Fedarisha is an S3-backed transport — there's no network endpoint
        // and no TLS/REALITY layer at the xray level. The credentials in
        // protocolOptions.storage carry everything needed; transport/security
        // are forced to inert tcp/none placeholders so the renderer skips
        // streamSettings for these outbounds.
        const transport: TransportVariant =
            protocol.protocol === 'fedarisha'
                ? { transport: 'tcp', transportOptions: { header: null } }
                : this.resolveTransport(inbound.streamSettings, inputHost, protocol, {
                      vlessUuid: user.vlessUuid,
                  });

        const security: SecurityVariant =
            protocol.protocol === 'fedarisha'
                ? { security: 'none' }
                : this.resolveSecurity(
                      inbound.streamSettings,
                      inputHost,
                      inbound.tag!,
                      ctx.publicKeyMap,
                      ctx.mldsa65PublicKeyMap,
                      address,
                  );

        return {
            finalRemark: finalRemark,
            address: address,
            port: inputHost.port,
            streamOverrides: {
                finalMask: override(
                    toNonEmptyRecord(inputHost.finalMask),
                    toNonEmptyRecord(inbound.streamSettings?.finalmask),
                ),
                sockopt: toNonEmptyRecord(inputHost.sockoptParams),
            },
            mux: toNonEmptyRecord(inputHost.muxParams),
            clientOverrides: {
                shuffleHost: inputHost.shuffleHost,
                mihomoX25519: inputHost.mihomoX25519,
                mihomoIpVersion: inputHost.mihomoIpVersion,
                serverDescription: inputHost.serverDescription
                    ? Buffer.from(inputHost.serverDescription).toString('base64')
                    : null,
                xrayJsonTemplate: inputHost.xrayJsonTemplate,
                mapper: inputHost.mapper,
            },
            metadata: {
                uuid: inputHost.uuid,
                tags: inputHost.tags,
                excludeFromSubscriptionTypes: inputHost.excludeFromSubscriptionTypes,
                inboundTag: inputHost.inboundTag,
                configProfileUuid: inputHost.configProfileUuid,
                configProfileInboundUuid: inputHost.configProfileInboundUuid,
                isDisabled: inputHost.isDisabled,
                isHidden: inputHost.isHidden,
                viewPosition: inputHost.viewPosition,
                remark: inputHost.remark,
                vlessRouteId: inputHost.vlessRouteId,
                rawInbound: inputHost.rawInbound,
            },
            ...protocol,
            ...security,
            ...transport,
        } satisfies ResolvedProxyConfig;
    }

    private resolveRandomizedValue(value: string): string {
        if (!value) return value;

        if (value.includes(',')) {
            const parts = value.split(',');
            return parts[Math.floor(Math.random() * parts.length)].trim();
        }

        if (value.includes('*')) {
            return value.replace('*', this.nanoid()).trim();
        }

        return value;
    }

    private isDomain(str: string): boolean {
        return this.domainRegex.test(str);
    }

    private deduplicateRemark(remark: string, knownRemarks: Map<string, number>): string {
        const currentCount = knownRemarks.get(remark) || 0;
        knownRemarks.set(remark, currentCount + 1);

        if (currentCount === 0) {
            return remark;
        }

        const hasExistingSuffix = remark.includes('^~') && remark.endsWith('~^');
        const suffix = hasExistingSuffix ? currentCount : currentCount + 1;
        return `${remark} ^~${suffix}~^`;
    }

    private applyHostOverrides(
        host: HostWithRawInbound,
        overrides?: ExternalSquadEntity['hostOverrides'],
    ): void {
        if (!overrides) return;

        if (overrides.vlessRouteId !== undefined) {
            host.vlessRouteId = overrides.vlessRouteId;
        }
        if (overrides.serverDescription !== undefined) {
            host.serverDescription = overrides.serverDescription;
        }
    }

    private applyShuffle(hosts: HostWithRawInbound[]): HostWithRawInbound[] {
        if (!hosts.some((h) => h.shuffleHost)) {
            return hosts;
        }
        return [...shuffle(filter(hosts, 'shuffleHost')), ...filter(hosts, (h) => !h.shuffleHost)];
    }

    private templateRemarks(
        remarks: string[],
        user: UserEntity,
        settings: SubscriptionSettingsEntity,
    ): string[] {
        const userValueMap = TemplateEngine.createUserValueMap(
            user,
            settings,
            this.subPublicDomain,
        );
        return remarks.map((remark) => TemplateEngine.replace(remark, userValueMap));
    }

    private parseResolvedProxyConfigFromRemark(remark: string): ResolvedProxyConfig | null {
        if (!remark.startsWith('{"f')) {
            return null;
        }

        try {
            const parsed: unknown = JSON.parse(remark);

            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return null;
            }

            return parsed as ResolvedProxyConfig;
        } catch {
            return null;
        }
    }

    private createFallbackHosts(remarks: string[]): ResolvedProxyConfig[] {
        return remarks.map(
            (remark) =>
                this.parseResolvedProxyConfigFromRemark(remark.trim()) ??
                ({
                    finalRemark: remark,
                    address: '0.0.0.0',
                    port: 1,
                    streamOverrides: {
                        finalMask: null,
                        sockopt: null,
                    },
                    mux: null,
                    protocol: 'vless',
                    protocolOptions: {
                        id: '00000000-0000-0000-0000-000000000000',
                        encryption: 'none',
                        flow: '',
                    },
                    transport: 'tcp',
                    transportOptions: {
                        header: null,
                    },
                    security: 'none',
                    clientOverrides: {
                        shuffleHost: false,
                        mihomoX25519: false,
                        serverDescription: null,
                        xrayJsonTemplate: null,
                        mihomoIpVersion: null,
                        mapper: {},
                    },
                    metadata: {
                        uuid: '00000000-0000-0000-0000-000000000000',
                        tags: [],
                        excludeFromSubscriptionTypes: [],
                        inboundTag: '',
                        configProfileUuid: null,
                        configProfileInboundUuid: null,
                        isDisabled: false,
                        isHidden: false,
                        viewPosition: 0,
                        remark: remark,
                        vlessRouteId: null,
                        rawInbound: null,
                    },
                } satisfies ResolvedProxyConfig),
        );
    }
}
