use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::Command;

struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[test]
#[ignore = "needs a display and a GPU"]
fn shot_draws_the_demo_scene() {
    let file =
        TempFile(std::env::temp_dir().join(format!("game-engine-shot-{}.png", std::process::id())));
    let demo = Path::new(env!("CARGO_MANIFEST_DIR")).join("games/demo");
    let output = Command::new(env!("CARGO_BIN_EXE_game-engine"))
        .arg("shot")
        .arg(&demo)
        .arg("-o")
        .arg(&file.0)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("wrote {}\n", file.0.display())
    );

    let decoder = png::Decoder::new(BufReader::new(File::open(&file.0).unwrap()));
    let mut reader = decoder.read_info().unwrap();
    let mut rgba = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut rgba).unwrap();
    assert_eq!((info.width, info.height), (800, 600));
    assert_eq!(
        (info.color_type, info.bit_depth),
        (png::ColorType::Rgba, png::BitDepth::Eight)
    );
    for (x, y, expected) in [
        (500, 200, [0, 255, 0]),
        (300, 433, [255, 102, 204]),
        (5, 5, [51, 77, 77]),
    ] {
        let at = (y * 800 + x) * 4;
        let actual = &rgba[at..at + 3];
        assert!(
            actual
                .iter()
                .zip(expected)
                .all(|(&a, e)| a.abs_diff(e) <= 2),
            "pixel ({x}, {y}) is {actual:?}, expected {expected:?} within 2"
        );
    }
}
