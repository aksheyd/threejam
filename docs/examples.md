# Example games

Play them in the browser from the [gallery](https://aksheyd.github.io/threejam/), where each one is the HTML file `npx threejam export` writes for it. Play them with a keyboard, or on a phone or tablet with the keys each one shows next to it, one for each key it reads. Asteroids also plays with the mouse, and on a touch screen a tap on the game starts it and a held finger aims and fires.

| Game | How to play | Worth reading for |
| --- | --- | --- |
| [Pong](../games/pong) ([play](https://aksheyd.github.io/threejam/pong.html)) | W and S move the left paddle, Up and Down the right. Space starts; first to 7 wins. | The smallest game; `view.ts` draws the net |
| [Breakout](../games/breakout) ([play](https://aksheyd.github.io/threejam/breakout.html)) | Left and Right (or A and D) move the paddle, and Space serves. Three lives to clear every brick. | A `grid` of bricks, and tests that play single-brick variants |
| [Snake](../games/snake) ([play](https://aksheyd.github.io/threejam/snake.html)) | An arrow key starts the snake, and the arrow keys turn it. Space plays again after a crash. | A `group` of hidden segments, since entities can't be added during a run |
| [Flappy](../games/flappy) ([play](https://aksheyd.github.io/threejam/flappy.html)) | Space starts a run, and each press flaps through the gaps. | Pipe pairs and a beak made of parts, and a `view.ts` that paints the skyline, pipes, ground, and bird over plain boxes |
| [Invaders](../games/invaders) ([play](https://aksheyd.github.io/threejam/invaders.html)) | Space starts; Left and Right move the cannon, and Space fires (hold it to keep firing). | Pixel art written as text with `sprites`, posed as the fleet marches, and an [autopilot](../games/invaders/autopilot.ts) driver |
| [Tetris](../games/tetris) ([play](https://aksheyd.github.io/threejam/tetris.html)) | Space starts; Left and Right move the piece, Up rotates it, and Down drops it faster. | A [driver](../games/tetris/plan.ts) that plays seed 0's first seven pieces into two cleared rows |
| [Asteroids](../games/asteroids) ([play](https://aksheyd.github.io/threejam/asteroids.html)) | Space or a click starts; Left and Right (or A and D) turn, Up (or W) thrusts, and Space fires. Or hold the mouse to aim at the pointer and fire, and the right button to thrust. | SVG rocks that spin and split, bullets and rocks pooled with `spawn`, a ship of turned parts, sounds, and a [driver](../games/asteroids/autopilot.ts) that plays with the mouse |
| [Racer](../games/racer) ([play](https://aksheyd.github.io/threejam/racer.html)) | Space starts the clock; Left and Right steer through the traffic to the finish line before it runs out. A crash spins the car out, and each coin adds a second. | 2D rules drawn in 3D: a [`view.ts`](../games/racer/view.ts) that renders the road with a perspective camera, lights, and shadows into a texture under the game's text, and an [autopilot](../games/racer/autopilot.ts) that picks lanes |

Keys are places on the keyboard, named for what a US keyboard has there, so on a French AZERTY keyboard W, A, S, and D are the keys marked Z, Q, S, and D. In a clone of this repo, play any of them with `npx threejam run games/<name>`. The frames at the top of the [README](../README.md) and in the [gallery](https://aksheyd.github.io/threejam/) come from `shot` at the default seed, 0, four of them played by those drivers and the rest by scheduled keys:

```bash
npx threejam shot games/racer --driver games/racer/autopilot.ts --at 1500 -o docs/images/racer.png
npx threejam shot games/asteroids --driver games/asteroids/autopilot.ts --at 420 -o docs/images/asteroids.png
npx threejam shot games/invaders --driver games/invaders/autopilot.ts --at 1075 -o docs/images/invaders.png
npx threejam shot games/flappy --press Space@1,35,69,103,137,171 --at 200 -o docs/images/flappy.png
npx threejam shot games/tetris --driver games/tetris/plan.ts --at 285 -o docs/images/tetris.png
npx threejam shot games/pong --press Space@1 --hold Up@2-27 --hold S@300-322 --at 425 -o docs/images/pong.png
npx threejam shot games/breakout --press Space@1 --hold Left@140-152 --at 495 -o docs/images/breakout.png
npx threejam shot games/snake --press Up@1,266 --press Left@58 --press Down@66 --press Right@178 --at 282 -o docs/images/snake.png
```
