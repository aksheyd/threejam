use glam::{DVec2, Vec2};

use crate::game::Align;

// The pixels are spaced out so rustfmt keeps each row on its own line.
const GLYPHS: [(char, [&str; 7]); 51] = [
    (
        'A',
        [
            ". # # # .",
            "# . . . #",
            "# . . . #",
            "# # # # #",
            "# . . . #",
            "# . . . #",
            "# . . . #",
        ],
    ),
    (
        'B',
        [
            "# # # # .",
            "# . . . #",
            "# . . . #",
            "# # # # .",
            "# . . . #",
            "# . . . #",
            "# # # # .",
        ],
    ),
    (
        'C',
        [
            ". # # # .",
            "# . . . #",
            "# . . . .",
            "# . . . .",
            "# . . . .",
            "# . . . #",
            ". # # # .",
        ],
    ),
    (
        'D',
        [
            "# # # . .",
            "# . . # .",
            "# . . . #",
            "# . . . #",
            "# . . . #",
            "# . . # .",
            "# # # . .",
        ],
    ),
    (
        'E',
        [
            "# # # # #",
            "# . . . .",
            "# . . . .",
            "# # # # .",
            "# . . . .",
            "# . . . .",
            "# # # # #",
        ],
    ),
    (
        'F',
        [
            "# # # # #",
            "# . . . .",
            "# . . . .",
            "# # # # .",
            "# . . . .",
            "# . . . .",
            "# . . . .",
        ],
    ),
    (
        'G',
        [
            ". # # # .",
            "# . . . #",
            "# . . . .",
            "# . # # #",
            "# . . . #",
            "# . . . #",
            ". # # # #",
        ],
    ),
    (
        'H',
        [
            "# . . . #",
            "# . . . #",
            "# . . . #",
            "# # # # #",
            "# . . . #",
            "# . . . #",
            "# . . . #",
        ],
    ),
    (
        'I',
        [
            ". # # # .",
            ". . # . .",
            ". . # . .",
            ". . # . .",
            ". . # . .",
            ". . # . .",
            ". # # # .",
        ],
    ),
    (
        'J',
        [
            ". . # # #",
            ". . . # .",
            ". . . # .",
            ". . . # .",
            ". . . # .",
            "# . . # .",
            ". # # . .",
        ],
    ),
    (
        'K',
        [
            "# . . . #",
            "# . . # .",
            "# . # . .",
            "# # . . .",
            "# . # . .",
            "# . . # .",
            "# . . . #",
        ],
    ),
    (
        'L',
        [
            "# . . . .",
            "# . . . .",
            "# . . . .",
            "# . . . .",
            "# . . . .",
            "# . . . .",
            "# # # # #",
        ],
    ),
    (
        'M',
        [
            "# . . . #",
            "# # . # #",
            "# . # . #",
            "# . # . #",
            "# . . . #",
            "# . . . #",
            "# . . . #",
        ],
    ),
    (
        'N',
        [
            "# . . . #",
            "# . . . #",
            "# # . . #",
            "# . # . #",
            "# . . # #",
            "# . . . #",
            "# . . . #",
        ],
    ),
    (
        'O',
        [
            ". # # # .",
            "# . . . #",
            "# . . . #",
            "# . . . #",
            "# . . . #",
            "# . . . #",
            ". # # # .",
        ],
    ),
    (
        'P',
        [
            "# # # # .",
            "# . . . #",
            "# . . . #",
            "# # # # .",
            "# . . . .",
            "# . . . .",
            "# . . . .",
        ],
    ),
    (
        'Q',
        [
            ". # # # .",
            "# . . . #",
            "# . . . #",
            "# . . . #",
            "# . # . #",
            "# . . # .",
            ". # # . #",
        ],
    ),
    (
        'R',
        [
            "# # # # .",
            "# . . . #",
            "# . . . #",
            "# # # # .",
            "# . # . .",
            "# . . # .",
            "# . . . #",
        ],
    ),
    (
        'S',
        [
            ". # # # #",
            "# . . . .",
            "# . . . .",
            ". # # # .",
            ". . . . #",
            ". . . . #",
            "# # # # .",
        ],
    ),
    (
        'T',
        [
            "# # # # #",
            ". . # . .",
            ". . # . .",
            ". . # . .",
            ". . # . .",
            ". . # . .",
            ". . # . .",
        ],
    ),
    (
        'U',
        [
            "# . . . #",
            "# . . . #",
            "# . . . #",
            "# . . . #",
            "# . . . #",
            "# . . . #",
            ". # # # .",
        ],
    ),
    (
        'V',
        [
            "# . . . #",
            "# . . . #",
            "# . . . #",
            "# . . . #",
            "# . . . #",
            ". # . # .",
            ". . # . .",
        ],
    ),
    (
        'W',
        [
            "# . . . #",
            "# . . . #",
            "# . . . #",
            "# . # . #",
            "# . # . #",
            "# . # . #",
            ". # . # .",
        ],
    ),
    (
        'X',
        [
            "# . . . #",
            "# . . . #",
            ". # . # .",
            ". . # . .",
            ". # . # .",
            "# . . . #",
            "# . . . #",
        ],
    ),
    (
        'Y',
        [
            "# . . . #",
            "# . . . #",
            "# . . . #",
            ". # . # .",
            ". . # . .",
            ". . # . .",
            ". . # . .",
        ],
    ),
    (
        'Z',
        [
            "# # # # #",
            ". . . . #",
            ". . . # .",
            ". . # . .",
            ". # . . .",
            "# . . . .",
            "# # # # #",
        ],
    ),
    (
        '0',
        [
            ". # # # .",
            "# . . . #",
            "# . . # #",
            "# . # . #",
            "# # . . #",
            "# . . . #",
            ". # # # .",
        ],
    ),
    (
        '1',
        [
            ". . # . .",
            ". # # . .",
            ". . # . .",
            ". . # . .",
            ". . # . .",
            ". . # . .",
            ". # # # .",
        ],
    ),
    (
        '2',
        [
            ". # # # .",
            "# . . . #",
            ". . . . #",
            ". . . # .",
            ". . # . .",
            ". # . . .",
            "# # # # #",
        ],
    ),
    (
        '3',
        [
            "# # # # #",
            ". . . # .",
            ". . # . .",
            ". . . # .",
            ". . . . #",
            "# . . . #",
            ". # # # .",
        ],
    ),
    (
        '4',
        [
            ". . . # .",
            ". . # # .",
            ". # . # .",
            "# . . # .",
            "# # # # #",
            ". . . # .",
            ". . . # .",
        ],
    ),
    (
        '5',
        [
            "# # # # #",
            "# . . . .",
            "# # # # .",
            ". . . . #",
            ". . . . #",
            "# . . . #",
            ". # # # .",
        ],
    ),
    (
        '6',
        [
            ". . # # .",
            ". # . . .",
            "# . . . .",
            "# # # # .",
            "# . . . #",
            "# . . . #",
            ". # # # .",
        ],
    ),
    (
        '7',
        [
            "# # # # #",
            ". . . . #",
            ". . . # .",
            ". . # . .",
            ". # . . .",
            ". # . . .",
            ". # . . .",
        ],
    ),
    (
        '8',
        [
            ". # # # .",
            "# . . . #",
            "# . . . #",
            ". # # # .",
            "# . . . #",
            "# . . . #",
            ". # # # .",
        ],
    ),
    (
        '9',
        [
            ". # # # .",
            "# . . . #",
            "# . . . #",
            ". # # # #",
            ". . . . #",
            ". . . # .",
            ". # # . .",
        ],
    ),
    (
        ' ',
        [
            ". . . . .",
            ". . . . .",
            ". . . . .",
            ". . . . .",
            ". . . . .",
            ". . . . .",
            ". . . . .",
        ],
    ),
    (
        '.',
        [
            ". . . . .",
            ". . . . .",
            ". . . . .",
            ". . . . .",
            ". . . . .",
            ". # # . .",
            ". # # . .",
        ],
    ),
    (
        ',',
        [
            ". . . . .",
            ". . . . .",
            ". . . . .",
            ". . . . .",
            ". # # . .",
            ". . # . .",
            ". # . . .",
        ],
    ),
    (
        ':',
        [
            ". . . . .",
            ". # # . .",
            ". # # . .",
            ". . . . .",
            ". # # . .",
            ". # # . .",
            ". . . . .",
        ],
    ),
    (
        ';',
        [
            ". . . . .",
            ". # # . .",
            ". # # . .",
            ". . . . .",
            ". # # . .",
            ". . # . .",
            ". # . . .",
        ],
    ),
    (
        '!',
        [
            ". . # . .",
            ". . # . .",
            ". . # . .",
            ". . # . .",
            ". . # . .",
            ". . . . .",
            ". . # . .",
        ],
    ),
    (
        '?',
        [
            ". # # # .",
            "# . . . #",
            ". . . . #",
            ". . . # .",
            ". . # . .",
            ". . . . .",
            ". . # . .",
        ],
    ),
    (
        '-',
        [
            ". . . . .",
            ". . . . .",
            ". . . . .",
            "# # # # #",
            ". . . . .",
            ". . . . .",
            ". . . . .",
        ],
    ),
    (
        '+',
        [
            ". . . . .",
            ". . # . .",
            ". . # . .",
            "# # # # #",
            ". . # . .",
            ". . # . .",
            ". . . . .",
        ],
    ),
    (
        '/',
        [
            ". . . . .",
            ". . . . #",
            ". . . # .",
            ". . # . .",
            ". # . . .",
            "# . . . .",
            ". . . . .",
        ],
    ),
    (
        '(',
        [
            ". . . # .",
            ". . # . .",
            ". # . . .",
            ". # . . .",
            ". # . . .",
            ". . # . .",
            ". . . # .",
        ],
    ),
    (
        ')',
        [
            ". # . . .",
            ". . # . .",
            ". . . # .",
            ". . . # .",
            ". . . # .",
            ". . # . .",
            ". # . . .",
        ],
    ),
    (
        '%',
        [
            "# # . . .",
            "# # . . #",
            ". . . # .",
            ". . # . .",
            ". # . . .",
            "# . . # #",
            ". . . # #",
        ],
    ),
    (
        '\'',
        [
            ". # # . .",
            ". . # . .",
            ". # . . .",
            ". . . . .",
            ". . . . .",
            ". . . . .",
            ". . . . .",
        ],
    ),
    (
        '"',
        [
            ". # . # .",
            ". # . # .",
            ". # . # .",
            ". . . . .",
            ". . . . .",
            ". . . . .",
            ". . . . .",
        ],
    ),
];

const ROWS: f64 = 7.0;
const ADVANCE: usize = 6;

fn glyph(c: char) -> Option<&'static [&'static str; 7]> {
    let c = c.to_ascii_uppercase();
    GLYPHS
        .iter()
        .find(|&&(known, _)| known == c)
        .map(|(_, rows)| rows)
}

pub fn check(text: &str) -> Result<(), String> {
    match text.chars().find(|&c| glyph(c).is_none()) {
        Some(c) => Err(format!("text can't draw {:?}", c.to_string())),
        None => Ok(()),
    }
}

// Each quad is (center, size) in world units.
pub fn quads(text: &str, anchor: DVec2, size: f64, align: Align) -> Vec<(Vec2, Vec2)> {
    let pixel = size / ROWS;
    let width = (text.chars().count() * ADVANCE).saturating_sub(1) as f64 * pixel;
    let left = anchor.x
        - match align {
            Align::Left => 0.0,
            Align::Center => width / 2.0,
            Align::Right => width,
        };
    let top = anchor.y + size / 2.0;
    let mut quads = Vec::new();
    for (i, c) in text.chars().enumerate() {
        for (row, pixels) in glyph(c).into_iter().flatten().enumerate() {
            let lit: Vec<bool> = pixels.bytes().step_by(2).map(|b| b == b'#').collect();
            let mut column = i * ADVANCE;
            for run in lit.chunk_by(|a, b| a == b) {
                if run[0] {
                    let center = DVec2::new(
                        left + (column as f64 + run.len() as f64 / 2.0) * pixel,
                        top - (row as f64 + 0.5) * pixel,
                    );
                    let extent = DVec2::new(run.len() as f64 * pixel, pixel);
                    quads.push((center.as_vec2(), extent.as_vec2()));
                }
                column += run.len();
            }
        }
    }
    quads
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(quads: &[(Vec2, Vec2)], top_left: DVec2, pixel: f64, columns: usize) -> Vec<String> {
        let cells = |length: f64| {
            let cells = length / pixel;
            assert!(
                (cells - cells.round()).abs() < 1e-4,
                "{length} isn't a whole number of pixels"
            );
            cells.round() as usize
        };
        let mut rows = vec![vec![b'.'; columns]; 7];
        for &(center, size) in quads {
            let (center, size) = (center.as_dvec2(), size.as_dvec2());
            assert_eq!(cells(size.y), 1, "{size}");
            let column = cells(center.x - size.x / 2.0 - top_left.x);
            let row = cells(top_left.y - center.y - size.y / 2.0);
            rows[row][column..column + cells(size.x)].fill(b'#');
        }
        rows.into_iter()
            .map(|row| String::from_utf8(row).unwrap())
            .collect()
    }

    #[test]
    fn text_lays_out_on_a_grid_of_size_over_7_pixels_placed_by_align() {
        let (anchor, size, pixel) = (DVec2::new(1.0, -0.5), 0.35, 0.05);
        let width = 11.0 * pixel;
        for (align, left) in [
            (Align::Left, 0.0),
            (Align::Center, -width / 2.0),
            (Align::Right, -width),
        ] {
            let top_left = anchor + DVec2::new(left, size / 2.0);
            assert_eq!(
                picture(&quads("Fp", anchor, size, align), top_left, pixel, 11),
                [
                    "#####.####.",
                    "#.....#...#",
                    "#.....#...#",
                    "####..####.",
                    "#.....#....",
                    "#.....#....",
                    "#.....#....",
                ],
                "{align:?}"
            );
        }
    }

    #[test]
    fn the_font_draws_exactly_the_documented_characters() {
        let mut drawn: Vec<char> = GLYPHS.iter().map(|&(c, _)| c).collect();
        let mut documented: Vec<char> = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;!?-+/()%'\""
            .chars()
            .collect();
        drawn.sort_unstable();
        documented.sort_unstable();
        assert_eq!(drawn, documented);
        for (c, rows) in GLYPHS {
            for row in rows {
                let pixels: Vec<&str> = row.split(' ').collect();
                assert!(
                    pixels.len() == 5 && pixels.iter().all(|&pixel| pixel == "#" || pixel == "."),
                    "{c:?}: {row:?}"
                );
            }
        }
        assert_eq!(check("the quick brown fox jumps over a lazy dog"), Ok(()));
        for c in ["é", "_", "#", "*", "\t", "\n"] {
            assert_eq!(
                check(&format!("A{c}")),
                Err(format!("text can't draw {c:?}")),
                "{c:?}"
            );
        }
    }
}
