import test from 'node:test'
import assert from 'node:assert/strict'
import { banner } from '../src/banner.js'

const ESCAPE = /\x1b\[/

test('a drawing is for a terminal; anything else gets one readable line', () => {
  const piped = banner('SUBTITLE', { version: '1.2.3', tty: false })

  assert.equal(piped, 'Sciilo · SUBTITLE 1.2.3\n')
  assert.doesNotMatch(piped, ESCAPE)
  assert.equal(piped.split('\n').length, 2, 'one line, and its newline')
})

test('NO_COLOR keeps the drawing and drops the escape codes', () => {
  const plain = banner('SUBTITLE', { tty: true, colour: false })

  assert.doesNotMatch(plain, ESCAPE)
  assert.match(plain, /██/)
  assert.match(plain, /●/, 'the mark stays: it is the drawing, not the colour')
})

test('the wordmark and the mark keep their shape', () => {
  const drawn = banner('SUBTITLE', { tty: true, colour: false }).split('\n')
  const art = drawn.filter(line => line.includes('██'))

  assert.equal(art.length, 5)
  const widths = new Set(art.map(line => line.length))
  assert.equal(widths.size, 1, 'every row is the same width, or the letters lean')
  assert.equal(art.filter(line => line.includes('●')).length, 3,
      'three connected nodes, exactly as the application mark')
})

test('a missing version leaves no dangling separator', () => {
  assert.equal(banner('SUBTITLE', { tty: false }), 'Sciilo · SUBTITLE\n')
  assert.match(banner('SUBTITLE', { tty: true, colour: false }), /SUBTITLE\n/)
})
