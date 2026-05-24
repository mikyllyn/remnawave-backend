type XrayInbound = {
    protocol?: unknown;
    settings?: unknown;
};

type FedarishaSettings = {
    storage?: {
        type?: unknown;
        bucket?: unknown;
    };
    webhook?: {
        enabled?: unknown;
        listen?: unknown;
        publicUrl?: unknown;
        autoSetup?: unknown;
    };
};

const DEFAULT_WEBHOOK_LISTEN = ':80';
const DEFAULT_WEBHOOK_PATH = '/webhook';

export const applyFedarishaWebhookDefaults = <T extends { inbounds?: unknown }>(
    config: T,
    nodeAddress: string,
): T => {
    if (!Array.isArray(config.inbounds)) {
        return config;
    }

    for (const inbound of config.inbounds) {
        if (!isXrayInbound(inbound) || inbound.protocol !== 'fedarisha') {
            continue;
        }

        const settings = ensureSettings(inbound);
        if (!isS3Storage(settings)) {
            continue;
        }

        if (!settings.webhook) {
            continue;
        }

        settings.webhook.enabled ??= true;
        settings.webhook.listen ??= DEFAULT_WEBHOOK_LISTEN;
        settings.webhook.publicUrl ??= buildDefaultPublicUrl(nodeAddress);
        settings.webhook.autoSetup ??= true;
    }

    return config;
};

const isXrayInbound = (value: unknown): value is XrayInbound => {
    return typeof value === 'object' && value !== null;
};

const ensureSettings = (inbound: XrayInbound): FedarishaSettings => {
    if (typeof inbound.settings !== 'object' || inbound.settings === null) {
        inbound.settings = {};
    }
    return inbound.settings as FedarishaSettings;
};

// All three PAK providers (vkcloud-pak / selectel-iam / static) are
// S3-backed transports and need the same webhook defaults; node-side
// just differs in how it mints per-user credentials.
const S3_STORAGE_TYPES = new Set(['vkcloud-pak', 'selectel-iam', 'static']);

const isS3Storage = (settings: FedarishaSettings): boolean => {
    const storage = settings.storage;
    if (!storage) {
        return false;
    }

    return typeof storage.type === 'string' && S3_STORAGE_TYPES.has(storage.type);
};

const buildDefaultPublicUrl = (nodeAddress: string): string => {
    const normalized = nodeAddress
        .trim()
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '');

    return `http://${normalized}${DEFAULT_WEBHOOK_PATH}`;
};
