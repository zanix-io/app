import { assertEquals } from '@std/assert'
import { RoundRobinPicker } from 'modules/runtime/round-robin.ts'

Deno.test('RoundRobinPicker: cycles through items in order, wrapping around', () => {
  const picker = new RoundRobinPicker()
  const items = ['a', 'b', 'c']

  assertEquals(picker.pick('key', items), 'a')
  assertEquals(picker.pick('key', items), 'b')
  assertEquals(picker.pick('key', items), 'c')
  assertEquals(picker.pick('key', items), 'a')
})

Deno.test('RoundRobinPicker: different keys keep independent counters', () => {
  const picker = new RoundRobinPicker()

  assertEquals(picker.pick('app-a', ['x', 'y']), 'x')
  assertEquals(picker.pick('app-b', ['x', 'y']), 'x')
  assertEquals(picker.pick('app-a', ['x', 'y']), 'y')
  assertEquals(picker.pick('app-b', ['x', 'y']), 'y')
})

Deno.test('RoundRobinPicker: a single-item list always returns that item', () => {
  const picker = new RoundRobinPicker()

  assertEquals(picker.pick('key', ['only']), 'only')
  assertEquals(picker.pick('key', ['only']), 'only')
})
