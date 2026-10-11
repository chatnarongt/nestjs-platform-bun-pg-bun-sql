import { Controller, Get, NotFoundException, Query, Res } from '@nestjs/common'
import { BunResponse } from '../../libs/platform-bun/shims.js'
import { DatabaseService } from '../database/database.service.js'
import { int, ints, pgIntArray, records } from './bench.parse.js'

type Q = string | string[] | undefined

@Controller('bench')
export class BenchController {
  constructor(private readonly db: DatabaseService) {}

  @Get('plaintext')
  plaintext(@Res() res: BunResponse) {
    res.send('Hello, World!')
  }

  @Get('json')
  json(@Res() res: BunResponse) {
    res.json({ message: 'Hello, World!' })
  }

  @Get('read-one')
  async readOne(@Query('id') id: Q) {
    const [row] = await this.db.sql`
      SELECT id, random_number AS "randomNumber" FROM world WHERE id = ${int(id, 'id')}`
    if (!row) throw new NotFoundException()
    return row
  }

  @Get('read-many')
  readMany(@Query('limit') limit: Q, @Query('afterId') afterId: Q) {
    const n = limit === undefined ? 20 : int(limit, 'limit')
    return this.db.sql`
      SELECT id, random_number AS "randomNumber" FROM world
      WHERE id > ${afterId === undefined ? 0 : int(afterId, 'afterId')}
      ORDER BY id LIMIT ${Math.min(Math.max(n, 1), 100)}`
  }

  @Get('create-one')
  async createOne(@Query('randomNumber') randomNumber: Q) {
    const [row] = await this.db.sql`
      INSERT INTO world (random_number) VALUES (${int(randomNumber, 'randomNumber')})
      RETURNING id, random_number AS "randomNumber"`
    return row
  }

  @Get('create-many')
  createMany(@Query('randomNumber') randomNumber: Q) {
    return this.db.sql`
      INSERT INTO world (random_number)
      SELECT unnest(${pgIntArray(ints(randomNumber, 'randomNumber'))}::int[])
      RETURNING id, random_number AS "randomNumber"`
  }

  @Get('update-one')
  async updateOne(@Query('record') record: Q) {
    const [r] = records(record)
    const [row] = await this.db.sql`
      UPDATE world SET random_number = ${r.randomNumber} WHERE id = ${r.id}
      RETURNING id, random_number AS "randomNumber"`
    if (!row) throw new NotFoundException()
    return row
  }

  @Get('update-many')
  updateMany(@Query('record') record: Q) {
    const rs = records(record)
    return this.db.sql`
      UPDATE world w SET random_number = v.r
      FROM unnest(${pgIntArray(rs.map((r) => r.id))}::int[],
                  ${pgIntArray(rs.map((r) => r.randomNumber))}::int[]) AS v(id, r)
      WHERE w.id = v.id
      RETURNING w.id, w.random_number AS "randomNumber"`
  }

  @Get('delete-one')
  async deleteOne(@Query('id') id: Q) {
    await this.db.sql`DELETE FROM world WHERE id = ${int(id, 'id')}`
  }

  @Get('delete-many')
  async deleteMany(@Query('id') id: Q) {
    await this.db.sql`DELETE FROM world WHERE id = ANY(${pgIntArray(ints(id, 'id'))}::int[])`
  }
}
