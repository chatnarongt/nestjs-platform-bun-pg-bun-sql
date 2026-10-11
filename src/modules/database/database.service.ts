import { Injectable, type OnModuleDestroy } from '@nestjs/common'
import { SQL } from 'bun'

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  // ponytail: Bun's SQL is a factory fn, not a class — wrap, don't extend. Use `db.sql\`...\``.
  readonly sql = new SQL({
    adapter: 'postgres',
    hostname: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    max: Number(process.env.DATABASE_MAX_POOL_SIZE),
  })

  onModuleDestroy() {
    return this.sql.close()
  }
}
