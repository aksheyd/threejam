# Making a game

A game is a folder with a `game.ts`, and `threejam new` writes one you can play and change right away. Its entities are plain data, and `update` changes them 60 times a second. Here's the heart of the game of catch that `npx threejam new games/catch` writes:

```ts
const entities = {
  paddle: { x: 0, y: -1.3, w: 0.6, h: 0.08, color: 'deepskyblue', speed: 3 },
  ball: { x: 0, y: 1.2, w: 0.12, h: 0.12, shape: 'circle', color: 'orange', visible: false, speed: 1.5 },
  score: { x: -1.9, y: 1.38, text: 'SCORE 0', align: 'left' },
  missed: { x: 1.9, y: 1.38, text: 'MISSES 0', align: 'right' },
  message: { x: 0, y: 0.2, text: 'PRESS SPACE TO START' },
  game: { state: oneOf(['ready', 'play', 'over']), points: 0, misses: 0, most_misses: 3 },
} satisfies Entities

function play(world: Catch, ctx: Context): void {
  const { paddle, ball, game, message } = world
  const move = (ctx.input.held('Right') || ctx.input.held('D') ? 1 : 0) - (ctx.input.held('Left') || ctx.input.held('A') ? 1 : 0)
  const edge = 2 - paddle.w / 2
  paddle.x = Math.max(-edge, Math.min(edge, paddle.x + move * paddle.speed * ctx.dt))
  ball.y -= ball.speed * ctx.dt
  const caught = Math.abs(ball.y - paddle.y) < (ball.h + paddle.h) / 2 && Math.abs(ball.x - paddle.x) < (ball.w + paddle.w) / 2
  if (caught) {
    game.points += 1
    ctx.print(`caught, score ${game.points}`)
    ctx.play('coin')
    drop(ball, ctx)
  } else if (ball.y < -1.5) {
    game.misses += 1
    ctx.print(`missed, ${game.misses} of ${game.most_misses}`)
    if (game.misses < game.most_misses) {
      ctx.play('hit')
      drop(ball, ctx)
      return
    }
    game.state = 'over'
    ball.visible = false
    message.text = 'GAME OVER - PRESS SPACE'
    message.visible = true
    ctx.play('lose')
  }
}
```

The screen spans x from -2 to 2 and y from -1.5 to 1.5, an entity's `x, y` is its center, and `ctx.dt` is always 1/60 of a second.

## Check it and prove what it does

With the default seed, the first ball falls at x 1.61, where a paddle that stays put misses it; holding Right from tick 2 to tick 40 catches it:

```console
$ npx threejam check games/catch
ok: true
entities: 6

$ npx threejam sim games/catch --ticks 120 --press Space@1 --hold Right@2-40 --filter-output log
log[1]{tick,text}:
  98,"caught, score 1"
cta:
  description: "Suggested command:"
  commands[1]{command,description}:
    threejam shot games/catch --at 120 --press Space@1 --hold Right@2-40,See this tick as a PNG
```

## Look at it, play it, and share it

This `shot` writes `frames/catch-001.png` and `frames/catch-098.png` from one run, and `export` writes one HTML file, images and sounds included, that plays the game offline for anyone you send it to:

```bash
npx threejam shot games/catch --at 1,98 --press Space@1 --hold Right@2-40 -o frames/catch.png
npx threejam run games/catch
npx threejam export games/catch -o catch.html
```

## Test it

`new` also wrote `game.test.ts`, which pins what the game does, and `node --test` runs it, or `npm test` in a project `new` made:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { simulate } from 'threejam'
import game from './game.ts'

test('holding Right catches the first ball with a sound, and a paddle that stays put misses it', () => {
  const still = simulate(game, { ticks: 110, press: ['Space@1'] })
  assert.deepEqual(still.logs, [{ tick: 110, text: 'missed, 1 of 3' }])
  const moved = simulate(game, { ticks: 110, press: ['Space@1'], hold: ['Right@2-40'] })
  assert.deepEqual(moved.logs, [{ tick: 98, text: 'caught, score 1' }])
  assert.deepEqual(moved.sounds, [{ tick: 98, name: 'coin', volume: 1, pitch: 1 }])
  assert.equal(moved.world.score.text, 'SCORE 1')
})
```

## Going further

[`AGENTS.md`](../AGENTS.md) covers the rest: groups, grids, and `spawn`, parts, `oneOf`, `listOf`, and `maybe`, text, turning, images, sounds, the mouse, `view.ts`, drivers, and every rule the engine checks. It ships in the package too, as `node_modules/threejam/AGENTS.md`. The [example games](examples.md) show each of these in a full game.
