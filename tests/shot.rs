use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::process::{Command, Output};

#[path = "../src/test_support.rs"]
mod test_support;

use test_support::TempGame;

fn run_shot(game: &Path, args: &[&str]) -> Output {
    let output = Command::new(env!("CARGO_BIN_EXE_game-engine"))
        .arg("shot")
        .arg(game)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn shot(game: &Path, file: &str) -> Vec<u8> {
    let output = run_shot(game, &["-o", file]);
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("wrote {file}\n")
    );
    read_png(file)
}

fn read_png(file: &str) -> Vec<u8> {
    let decoder = png::Decoder::new(BufReader::new(File::open(file).unwrap()));
    let mut reader = decoder.read_info().unwrap();
    let mut rgba = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut rgba).unwrap();
    assert_eq!((info.width, info.height), (800, 600));
    assert_eq!(
        (info.color_type, info.bit_depth),
        (png::ColorType::Rgba, png::BitDepth::Eight)
    );
    rgba
}

// Opacity blends separately from color, so a translucent sprite still leaves the PNG opaque.
fn assert_pixels(rgba: &[u8], pixels: &[(usize, usize, [u8; 3])]) {
    for &(x, y, expected) in pixels {
        let at = (y * 800 + x) * 4;
        let actual = &rgba[at..at + 4];
        assert!(
            actual
                .iter()
                .zip(expected)
                .all(|(&a, e)| a.abs_diff(e) <= 2)
                && actual[3] == 255,
            "pixel ({x}, {y}) is {actual:?}, expected {expected:?} within 2 and opaque"
        );
    }
}

#[test]
#[ignore = "needs a display and a GPU"]
fn shot_draws_the_demo_scene() {
    let temp = TempGame::new(&[]);
    let demo = Path::new(env!("CARGO_MANIFEST_DIR")).join("games/demo");
    let rgba = shot(&demo, &temp.path("shot.png"));
    assert_pixels(
        &rgba,
        &[
            (500, 200, [0, 255, 0]),
            (300, 433, [255, 102, 204]),
            (5, 5, [51, 77, 77]),
        ],
    );
}

#[test]
#[ignore = "needs a display and a GPU"]
fn a_half_opaque_square_blends_with_the_colors_under_it() {
    let game = TempGame::new(&[(
        "scene.toml",
        "background = [0, 0, 0]\n\n\
         [[entity]]\nname = \"red\"\ntransform = { position = [-0.5, 0], scale = [2, 2] }\n\
         mesh = { shape = \"square\", color = [1, 0, 0] }\n\n\
         [[entity]]\nname = \"veil\"\ntransform = { position = [0.5, 0], scale = [2, 2] }\n\
         mesh = { shape = \"square\", color = [1, 1, 1, 0.5] }\n",
    )]);
    let rgba = shot(&game.dir, &game.path("shot.png"));
    // Red covers screen x 100 to 500 and the veil 300 to 700, so x = 400 is both and x = 600 the veil over black.
    assert_pixels(
        &rgba,
        &[(400, 300, [255, 128, 128]), (600, 300, [128, 128, 128])],
    );
}

#[test]
#[ignore = "needs a display and a GPU"]
fn shot_draws_text_where_the_font_says() {
    let game = TempGame::new(&[(
        "scene.toml",
        "background = [0, 0, 0]\n\n[[entity]]\nname = \"label\"\n\
         transform = { position = [-1, 0.5] }\n\
         text = { value = \"F\", size = 0.7, align = \"left\", color = [1, 0.5, 0] }\n",
    )]);
    let rgba = shot(&game.dir, &game.path("shot.png"));
    // A font pixel is 0.7 / 7 = 0.1 units, or 20 screen pixels, and the glyph's top-left corner is at (200, 130).
    let cell = |column: usize, row: usize| (210 + 20 * column, 140 + 20 * row);
    // F's top row is lit out to its fifth pixel, and its second row lights only the first.
    let (lit, unlit) = (cell(4, 0), cell(4, 1));
    assert_pixels(
        &rgba,
        &[(lit.0, lit.1, [255, 128, 0]), (unlit.0, unlit.1, [0, 0, 0])],
    );
}

#[test]
#[ignore = "needs a display and a GPU"]
fn shot_at_saves_the_frame_at_each_tick_from_one_run() {
    let game = TempGame::new(&[
        (
            "scene.toml",
            "background = [0, 0, 0]\n\n[[entity]]\nname = \"mover\"\n\
             transform = { position = [-1, 0], scale = [0.5, 0.5] }\n\
             mesh = { shape = \"square\" }\nscript = { file = \"mover.lua\" }\n",
        ),
        (
            "scripts/mover.lua",
            "function start(self)\n  print(\"start\")\nend\n\n\
             function update(self, dt)\n  self.x = self.x + dt\nend\n",
        ),
    ]);
    let output = run_shot(
        &game.dir,
        &["--at", "120,0,60", "-o", &game.path("frame.png")],
    );
    // A second run would print start again.
    assert_eq!(String::from_utf8_lossy(&output.stderr), "[tick 0] start\n");
    let files = ["000", "060", "120"].map(|tick| game.path(&format!("frame-{tick}.png")));
    let wrote: String = files.iter().map(|file| format!("wrote {file}\n")).collect();
    assert_eq!(String::from_utf8_lossy(&output.stdout), wrote);
    // The mover is at x = -1, 0, and 1 on ticks 0, 60, and 120, which is screen x 200, 400, and 600.
    for (file, lit) in files.iter().zip([200, 400, 600]) {
        let rgba = read_png(file);
        let expected = [200, 400, 600].map(|x| (x, 300, [if x == lit { 255 } else { 0 }; 3]));
        assert_pixels(&rgba, &expected);
    }
}
