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
    // The node mints its S3 sub-credential under `<userUuid>-<sha1(inboundTag)>`
    // and its contract validates this as a real UUID. Remnawave 3.0.0 dropped the
    // users.uuid column that used to fill this, so vlessUuid — the remaining
    // per-user UUID — takes over. Handles derived from the old column can no
    // longer be recomputed, so PAKs issued before the 3.x upgrade are re-minted
    // on first probe and their predecessors have to be swept on the S3 side.
    userUuid: string;
    inbound: IFedarishaInboundContext;
}

export interface IEnsureCredentialsResult {
    accessKey: string;
    secretKey: string;
    prefix: string;
}
