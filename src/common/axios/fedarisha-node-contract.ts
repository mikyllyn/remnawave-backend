// Vendored copy of fedarisha node-contract types until @remnawave/node-contract
// republishes with fedarisha support. Mirrors /home/stalk/fedarisha/node/libs/contract/commands/fedarisha.

const FEDARISHA_ROOT = '/node/fedarisha';

export const FEDARISHA_NODE_ROUTES = {
    PROVISION_USER: `${FEDARISHA_ROOT}/provision-user`,
    REVOKE_USER: `${FEDARISHA_ROOT}/revoke-user`,
    PROBE_USER: `${FEDARISHA_ROOT}/probe-user`,
} as const;

export interface ProvisionFedarishaUserRequest {
    userUuid: string;
    inboundTag: string;
    prefix: string;
}

export interface ProvisionFedarishaUserResponse {
    response: {
        isOk: boolean;
        accessKey: string | null;
        secretKey: string | null;
        error: string | null;
    };
}

export interface RevokeFedarishaUserRequest {
    userUuid: string;
    inboundTag: string;
    prefix: string;
}

export interface RevokeFedarishaUserResponse {
    response: {
        isOk: boolean;
        error: string | null;
    };
}

// Probe verifies that the cached PAK still authenticates against the bucket
// the node currently serves for this inbound. Node should resolve bucket /
// endpoint / region from its xray config (so admin-side bucket swaps are
// caught for free) and issue a cheap auth-touching call (HeadBucket or
// ListObjectsV2 with MaxKeys=1) using the supplied user creds.
//
// `exists: false` means the credentials authenticated but no longer have
// access (deleted PAK, revoked permissions, prefix wiped). `exists: true`
// + `isOk: true` is the only "fresh" combination — anything else triggers
// a silent re-issue on the panel side.
export interface ProbeFedarishaUserRequest {
    userUuid: string;
    inboundTag: string;
    prefix: string;
    accessKey: string;
    secretKey: string;
}

export interface ProbeFedarishaUserResponse {
    response: {
        isOk: boolean;
        exists: boolean;
        error: string | null;
    };
}
