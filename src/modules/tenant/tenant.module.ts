import { Module, Global } from '@nestjs/common';
import { TenantDbManager } from './tenant-db.manager';

@Global()
@Module({
    providers: [TenantDbManager],
    exports: [TenantDbManager],
})
export class TenantModule { }
