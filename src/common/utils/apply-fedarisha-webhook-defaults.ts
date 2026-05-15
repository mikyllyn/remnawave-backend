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

const isS3Storage = (settings: FedarishaSettings): boolean => {
    const storage = settings.storage;
    if (!storage) {
        return false;
    }

    return storage.type === 's3' || (!storage.type && typeof storage.bucket === 'string');
};

const buildDefaultPublicUrl = (nodeAddress: string): string => {
    const normalized = nodeAddress
        .trim()
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '');

    return `http://${normalized}${DEFAULT_WEBHOOK_PATH}`;
};
