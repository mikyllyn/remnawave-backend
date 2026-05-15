// Per-user fedarisha PAK persisted into user_meta.metadata.fedarisha[inboundTag].
// No new tables — UserMeta is a generic JSONB kv-store keyed on users.t_id.
export interface IFedarishaPakPayload {
    accessKey: string;
    secretKey: string;
    prefix: string;
    configProfileUuid: string;
    issuedAt: string;
}

export type IFedarishaUserMetaSection = Record<string, IFedarishaPakPayload>;

export const FEDARISHA_META_KEY = 'fedarisha' as const;

export interface IFedarishaInboundContext {
    inboundTag: string;
    basePrefix: string;
    configProfileUuid: string;
    nodeAddress: string;
    nodePort: number | null;
}

export interface IEnsureCredentialsInput {
    userUuid: string;
    inbound: IFedarishaInboundContext;
}

export interface IEnsureCredentialsResult {
    accessKey: string;
    secretKey: string;
    prefix: string;
}
