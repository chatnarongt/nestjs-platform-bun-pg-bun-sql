import { BadRequestException } from '@nestjs/common'

type QueryValue = string | string[] | undefined

const MAX_ITEMS = 100
const INT_MIN = -(2 ** 31)
const INT_MAX = 2 ** 31 - 1

function toList(value: QueryValue, name: string): string[] {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value]
  if (list.length === 0) throw new BadRequestException(`${name} is required`)
  if (list.length > MAX_ITEMS) throw new BadRequestException(`${name}: max ${MAX_ITEMS} items`)
  return list
}

function toInt(value: unknown, name: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < INT_MIN || n > INT_MAX)
    throw new BadRequestException(`${name} must be a 32-bit integer`)
  return n
}

export const int = (value: QueryValue, name: string) => toInt(toList(value, name)[0], name)

export const ints = (value: QueryValue, name: string) =>
  toList(value, name).map((v) => toInt(v, name))

export type WorldRecord = { id: number; randomNumber: number }

export function records(value: QueryValue): WorldRecord[] {
  return toList(value, 'record').map((raw) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new BadRequestException('record must be JSON')
    }
    const r = (parsed ?? {}) as Record<string, unknown>
    return { id: toInt(r.id, 'record.id'), randomNumber: toInt(r.randomNumber, 'record.randomNumber') }
  })
}

/** Postgres array literal; safe because inputs are validated integers. */
export const pgIntArray = (values: number[]) => `{${values.join(',')}}`
