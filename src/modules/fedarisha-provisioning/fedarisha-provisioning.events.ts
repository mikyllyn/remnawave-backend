import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { EVENTS } from '@libs/contracts/constants';
import { USERS_STATUS } from '@libs/contracts/constants';

import { UserEvent } from '@integration-modules/notifications/interfaces';

import { FedarishaProvisioningService } from './fedarisha-provisioning.service';

@Injectable()
export class FedarishaProvisioningEvents {
    private readonly logger = new Logger(FedarishaProvisioningEvents.name);

    constructor(private readonly provisioning: FedarishaProvisioningService) {}

    // Revoke per-user PAK on the bucket once a user loses entitlement.
    // Why: VLESS/Trojan rely on xray's runtime UserManager to drop sessions on
    // LIMITED/EXPIRED, but Fedarisha clients hold standalone S3 PAK creds —
    // until the PAK itself is revoked the bucket keeps accepting their writes
    // and the listener keeps proxying. The PAK row is rebuilt by the next
    // subscription render via ensureCredentials when status flips back.
    // Idempotent: revokeForUser bails out early if the user has no stored PAKs.
    @OnEvent(EVENTS.USER.DELETED)
    async onUserDeleted(event: UserEvent): Promise<void> {
        await this.handle(event, 'deleted');
    }

    @OnEvent(EVENTS.USER.DISABLED)
    async onUserDisabled(event: UserEvent): Promise<void> {
        await this.handle(event, 'disabled');
    }

    @OnEvent(EVENTS.USER.LIMITED)
    async onUserLimited(event: UserEvent): Promise<void> {
        await this.handle(event, 'limited');
    }

    @OnEvent(EVENTS.USER.EXPIRED)
    async onUserExpired(event: UserEvent): Promise<void> {
        await this.handle(event, 'expired');
    }

    // Restore PAKs as soon as the user transitions back to ACTIVE. The natural
    // restore happens when the client refetches its subscription, but Happ &
    // friends honour profile-update-interval (12h by default) so users would
    // appear stuck after admin "added traffic" until their app cycles. By
    // pre-issuing here we make the next subscription render a no-op probe and
    // the next client refetch instantly hands them working creds.
    @OnEvent(EVENTS.USER.ENABLED)
    async onUserEnabled(event: UserEvent): Promise<void> {
        await this.maybeEnsure(event, 'enabled');
    }

    @OnEvent(EVENTS.USER.TRAFFIC_RESET)
    async onUserTrafficReset(event: UserEvent): Promise<void> {
        await this.maybeEnsure(event, 'traffic_reset');
    }

    @OnEvent(EVENTS.USER.MODIFIED)
    async onUserModified(event: UserEvent): Promise<void> {
        await this.maybeEnsure(event, 'modified');
    }

    private async handle(event: UserEvent, reason: string): Promise<void> {
        try {
            await this.provisioning.revokeForUser(event.user.tId, event.user.uuid);
        } catch (error) {
            this.logger.warn(
                `Fedarisha PAK revoke failed for user ${event.user.uuid} (${reason}): ${error}`,
            );
        }
    }

    private async maybeEnsure(event: UserEvent, reason: string): Promise<void> {
        if (event.user.status !== USERS_STATUS.ACTIVE) return;
        try {
            await this.provisioning.ensureForUser(event.user.tId, event.user.uuid);
        } catch (error) {
            this.logger.warn(
                `Fedarisha PAK ensure failed for user ${event.user.uuid} (${reason}): ${error}`,
            );
        }
    }
}
