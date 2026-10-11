import { BadRequestException } from '@nestjs/common'
import { int, ints, pgIntArray, records } from './bench.parse.js'

test('int/ints', () => {
  expect(int('42', 'id')).toBe(42)
  expect(int(['7', '8'], 'id')).toBe(7)
  expect(ints(['1', '2'], 'id')).toEqual([1, 2])
  for (const bad of [undefined, '', 'x', '1.5', '2147483648', '1;drop'])
    expect(() => int(bad, 'id')).toThrow(BadRequestException)
  expect(() => ints(Array(101).fill('1'), 'id')).toThrow(BadRequestException)
})

test('records', () => {
  expect(records('{"id":1,"randomNumber":42}')).toEqual([{ id: 1, randomNumber: 42 }])
  expect(records(['{"id":1,"randomNumber":2}', '{"id":3,"randomNumber":4}'])).toHaveLength(2)
  for (const bad of ['nope', 'null', '{"id":1.5,"randomNumber":2}', '{"id":1}'])
    expect(() => records(bad)).toThrow(BadRequestException)
})

test('pgIntArray', () => {
  expect(pgIntArray([1, 2, 3])).toBe('{1,2,3}')
})
