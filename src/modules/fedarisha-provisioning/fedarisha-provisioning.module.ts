import { Module } from '@nestjs/common';

import { AxiosModule } from '@common/axios/axios.module';

import { FedarishaProvisioningEvents } from './fedarisha-provisioning.events';
import { FedarishaProvisioningRepository } from './fedarisha-provisioning.repository';
import { FedarishaProvisioningService } from './fedarisha-provisioning.service';
import { FedarishaSubscriptionService } from './fedarisha-subscription.service';

@Module({
    // AxiosModule is @Global, but only within whichever root module pulls it in,
    // and 3.x stopped importing it from the api and scheduler roots — it now
    // hangs off the processors root alone. This module is loaded by all three,
    // so it imports AxiosModule itself rather than depending on the root wiring.
    imports: [AxiosModule],
    providers: [
        FedarishaProvisioningRepository,
        FedarishaProvisioningService,
        FedarishaProvisioningEvents,
        FedarishaSubscriptionService,
    ],
    exports: [FedarishaProvisioningService, FedarishaSubscriptionService],
})
export class FedarishaProvisioningModule {}
